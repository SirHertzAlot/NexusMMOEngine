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
}

export class CraftingService implements GatewayExtension {
  readonly kind = "craft";

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
