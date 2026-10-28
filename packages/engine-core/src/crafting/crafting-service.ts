/**
 * Crafting gateway extension (kind "craft"): Zod-validated execution of
 * crafting actions through the @mmo-engine/crafting rules.
 *
 * A GatewayExtension like QuestService (quests/quest-service.ts), but pure
 * request/response — crafting is player-initiated, so there is no tick
 * logic and no SimSystem. Every inbound message is validated with Zod at
 * the boundary; anything that fails validation is answered with a notice
 * and never reaches the crafting systems (fail closed).
 *
 * Execution is check-then-act inside one synchronous block — recipe,
 * mastery, materials, bag room, then consume and grant — so nothing is
 * consumed unless the whole craft can complete. The world-facing seams
 * (mastery, materials, bag, grant) are narrow injected callbacks: the
 * service owns no storage, exactly like QuestService's
 * countInBag/grant/grantGold.
 *
 * Fleet mode (slice A2's execution step, ported onto this service):
 * when an `atomicCraft` executor is wired, the commit step of a craft
 * routes through the world-tier `craftExecute` operation (one
 * WorldStore transaction) instead of granting locally. The recipe
 * inputs are pouch materials — region-side state the world record
 * does not hold — so the world-tier movement of a gateway craft is
 * the produced item: it is allocated locally in the Free state, the
 * world commits it into the character's record, the settled outcome
 * reconciles it into the bag, and only then are the pouch materials
 * consumed. Fail closed: a typed rejection or a world outage crafts
 * nothing — the pre-allocated output is destroyed, the pouch is
 * untouched, and the refusal surfaces as the usual failure notice.
 * No local fallback, ever. Without an executor the service is
 * exactly the standalone one above.
 *
 * Wire messages (0x11, kind "craft"):
 * - in:  { kind: "craft", op: "craft", item, rank }    craft the item
 * - in:  { kind: "craft", op: "recipe", item, rank }   ask what it costs
 * - out: { kind: "craft", op: "crafted", item, rank }
 * - out: { kind: "craft", op: "recipe", item, rank, skill, mastery, inputs, tier }
 * Failures go back as system-channel chat notices, the gateway's existing
 * way of telling a player something didn't happen.
 */

import { z } from "zod";
import { composeItem, type EntityBundle } from "@mmo-engine/compose";
import { recipeFor, type CraftingRules, type Recipe } from "@mmo-engine/crafting";
import type { ExtensionPlayer, GatewayExtension } from "../net/extension.js";
import { itemInstanceId } from "../world/atomic-ops.js";

/**
 * The fleet-mode craft executor: routes one craft's commit through
 * the world tier. Returns the settled outcome as a value; an outage
 * throws. Supplied by the server's fleet wiring (WorldAtomicOps).
 */
export interface AtomicCraftExecutor {
  craft(
    character: number,
    consumes: Array<{ instanceId: string; count: number }>,
    goldFee: number,
    outputs: Array<{ instanceId: string; def: number }>,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
}

const itemId = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase id (a-z, 0-9, -)").max(64);
const rankId = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase id (a-z, 0-9, -)").max(32);

/** The full wire message, validated at the gateway boundary. */
export const CraftMessageSchema = z.discriminatedUnion("op", [
  z.strictObject({ kind: z.literal("craft"), op: z.literal("craft"), item: itemId, rank: rankId }),
  z.strictObject({ kind: z.literal("craft"), op: z.literal("recipe"), item: itemId, rank: rankId }),
]);
export type CraftMessage = z.infer<typeof CraftMessageSchema>;

export interface CraftingServiceOptions {
  /** The game's crafting rules (content/crafting/recipes.json), already loaded by the server. */
  rules: CraftingRules;
  /** Resolve a catalog item + rank to its composed bundle. Default: composeItem (deterministic). */
  composeItem?: (item: string, rank: string) => EntityBundle;
  /** Derive the recipe for a bundle. Default: recipeFor from @mmo-engine/crafting. */
  deriveRecipe?: (bundle: EntityBundle, rules: CraftingRules) => Recipe;
  /** Skill level (0..1) of `skill` for the avatar entity. */
  masteryOf: (entity: number, skill: string) => number;
  /** Raw material units the character holds. */
  countMaterial: (character: number, material: string) => number;
  /**
   * Consume raw material units. Called synchronously right after the
   * countMaterial check in the same block — no awaits between, so the
   * pouch cannot change underneath. Return false only on unexpected
   * failure; the service aborts the craft without granting.
   */
  takeMaterial: (character: number, material: string, qty: number) => boolean;
  /** Whether the character's bag has room for the crafted item. Checked before anything is consumed. */
  hasBagRoom: (character: number) => boolean;
  /** Give the crafted item. Only called after every input was consumed. */
  grantItem: (character: number, item: string, rank: string) => boolean;
  /**
   * Fleet mode: the world-tier craft executor. Absent: crafts commit
   * locally, exactly as the standalone service always has. Present:
   * the four seams below must be wired too.
   */
  atomicCraft?: AtomicCraftExecutor;
  /** Fleet only: the item definition a catalog item + rank resolves to; -1 when none. */
  defOfItem?: (item: string, rank: string) => number;
  /** Fleet only: create the output item in the Free state (in no bag); its region id, or -1. */
  allocateItem?: (def: number) => number;
  /** Fleet only: destroy an item allocated for a craft that did not commit. */
  discardItem?: (item: number) => void;
  /** Fleet only: whether the item is now in the character's bag (the settled outcome landed). */
  itemInBag?: (character: number, item: number) => boolean;
}

export class CraftingService implements GatewayExtension {
  readonly kind = "craft";
  /** Characters with a fleet-mode craft in flight (one per character). */
  private readonly fleetInFlight = new Set<number>();

  constructor(private readonly opts: CraftingServiceOptions) {}

  onMessage(player: ExtensionPlayer, raw: unknown): void {
    if (player.characterId === null || player.entity() < 0) {
      this.notice(player, "crafting needs a character");
      return;
    }
    const parsed = CraftMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.notice(player, "malformed craft request");
      return;
    }
    const m = parsed.data;
    if (m.op === "recipe") this.sendRecipe(player, m);
    else this.executeCraft(player, m);
  }

  private sendRecipe(player: ExtensionPlayer, m: Extract<CraftMessage, { op: "recipe" }>): void {
    const recipe = this.derive(player, m.item, m.rank);
    if (!recipe) return;
    player.send({
      kind: "craft",
      op: "recipe",
      item: m.item,
      rank: m.rank,
      skill: recipe.skill,
      mastery: recipe.mastery,
      inputs: recipe.inputs,
      tier: recipe.tier,
    });
  }

  private executeCraft(player: ExtensionPlayer, m: Extract<CraftMessage, { op: "craft" }>): void {
    const character = player.characterId as number;
    const recipe = this.derive(player, m.item, m.rank);
    if (!recipe) return;
    const level = this.opts.masteryOf(player.entity(), recipe.skill);
    if (level < recipe.mastery) {
      this.notice(player, `that needs ${recipe.skill} mastery ${Math.round(recipe.mastery * 100)}%`);
      return;
    }
    for (const [material, qty] of Object.entries(recipe.inputs)) {
      if (this.opts.countMaterial(character, material) < qty) {
        this.notice(player, `you need ${qty}x ${material}`);
        return;
      }
    }
    if (!this.opts.hasBagRoom(character)) {
      this.notice(player, "your bag is full");
      return;
    }
    if (this.opts.atomicCraft) {
      void this.executeCraftFleet(player, m, recipe, character);
      return;
    }
    // Consume, then grant — one synchronous block, no interleaving.
    for (const [material, qty] of Object.entries(recipe.inputs)) {
      if (!this.opts.takeMaterial(character, material, qty)) {
        this.notice(player, "crafting failed");
        return;
      }
    }
    if (!this.opts.grantItem(character, m.item, m.rank)) {
      this.notice(player, "crafting failed");
      return;
    }
    player.send({ kind: "craft", op: "crafted", item: m.item, rank: m.rank });
  }

  /**
   * The fleet-mode commit: the produced item is allocated locally
   * (Free state, in no bag) so the world execution and the local item
   * share one instance id, then the execution step routes through the
   * world tier. The pouch is debited only after the world commits —
   * one craft per character at a time, so the pouch cannot change
   * between the validation above and the debit here. On any failure
   * the allocation is destroyed and nothing is consumed.
   */
  private async executeCraftFleet(
    player: ExtensionPlayer,
    m: Extract<CraftMessage, { op: "craft" }>,
    recipe: Recipe,
    character: number,
  ): Promise<void> {
    const exec = this.opts.atomicCraft!;
    const { defOfItem, allocateItem, discardItem, itemInBag } = this.opts;
    if (!defOfItem || !allocateItem || !discardItem || !itemInBag) {
      this.notice(player, "crafting failed");
      return;
    }
    if (this.fleetInFlight.has(character)) {
      this.notice(player, "crafting failed");
      return;
    }
    const def = defOfItem(m.item, m.rank);
    if (def < 0) {
      this.notice(player, "crafting failed");
      return;
    }
    const allocated = allocateItem(def);
    if (allocated < 0) {
      this.notice(player, "crafting failed");
      return;
    }
    this.fleetInFlight.add(character);
    try {
      // Recipe inputs live in the pouch — region-side state the world
      // record does not hold — and gateway recipes carry no gold fee:
      // the world-tier movement of this craft is the produced item.
      const settled = await exec.craft(
        character,
        [],
        0,
        [{ instanceId: itemInstanceId(allocated), def }],
      );
      if (!settled.ok) {
        discardItem(allocated);
        this.notice(player, "crafting failed");
        return;
      }
    } catch {
      discardItem(allocated);
      this.notice(player, "crafting failed");
      return;
    } finally {
      this.fleetInFlight.delete(character);
    }
    // The world committed; the settled outcome reconciled the output
    // into the bag. Debit the pouch, then confirm the item landed
    // before reporting success.
    for (const [material, qty] of Object.entries(recipe.inputs)) {
      if (!this.opts.takeMaterial(character, material, qty)) {
        this.notice(player, "crafting failed");
        return;
      }
    }
    if (!itemInBag(character, allocated)) {
      this.notice(player, "crafting failed");
      return;
    }
    player.send({ kind: "craft", op: "crafted", item: m.item, rank: m.rank });
  }

  /** Resolve the bundle and derive its recipe. Notices and returns undefined on any failure. */
  private derive(player: ExtensionPlayer, item: string, rank: string): Recipe | undefined {
    let bundle: EntityBundle;
    try {
      bundle = this.opts.composeItem ? this.opts.composeItem(item, rank) : composeItem(item, rank).bundle;
    } catch {
      this.notice(player, `unknown item "${item}"`);
      return undefined;
    }
    try {
      return this.opts.deriveRecipe
        ? this.opts.deriveRecipe(bundle, this.opts.rules)
        : recipeFor(bundle, { rules: this.opts.rules });
    } catch {
      this.notice(player, "that can't be crafted");
      return undefined;
    }
  }

  private notice(player: ExtensionPlayer, text: string): void {
    player.send({ kind: "chat", channel: "system", text, from: "", entity: "" });
  }
}
