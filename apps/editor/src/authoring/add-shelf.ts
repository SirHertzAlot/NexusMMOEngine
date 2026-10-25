/**
 * The add shelf — "available to add", with establishability.
 *
 * For every module NOT already applied to the selection, decide whether
 * its precondition could ever hold for this object's kind:
 *
 * - establishable: the editor can create the precondition in one click.
 *   The action is stated in the same terms the widget layer executes —
 *   a canonical verb call (attachVendor, placeItemFixture, spawnCreature)
 *   or an explicit component/marker addition (add Health+Stamina, add
 *   FlowRef) for preconditions that are component-shaped, exactly as the
 *   design's own examples put it.
 * - never: this kind can never satisfy the rule (a plain prop/rock never
 *   offers the character sheet). The UI hides these — discovery without
 *   noise.
 *
 * Every verdict is grounded in the facts (kind + components), never in
 * the module's name.
 */

import { hasComponent, isPersonKind, type SelectionFacts } from "./facts.js";
import { inputValue, type ActionInput, type InputValues } from "./inputs.js";
import { evaluateRelevance, type ModuleId } from "./relevance.js";

export interface ShelfAction {
  /** Designer-language label: "Add vendor", "Add combat", … */
  label: string;
  /** Canonical verb that establishes the precondition, when the precondition is verb-shaped. */
  verb?: string;
  /** Params for the verb (targets filled from the selection; input values override the placeholders — see shelfActionParams). */
  params?: Record<string, unknown>;
  /** Fields the designer fills before the action can dispatch (data — see inputs.ts). */
  inputs?: readonly ActionInput[];
  /** Components/markers whose addition establishes the precondition, when it is component-shaped. */
  addComponents?: readonly string[];
}

/**
 * A shelf action's params with designer input values applied: each
 * declared input's resolved value (typed value, else its prefill)
 * overrides the action's placeholder param of the same id; an empty
 * value leaves the placeholder, and the dispatch mapper refuses it
 * with its reason — the mapper stays the single gate.
 */
export function shelfActionParams(action: ShelfAction, values: InputValues): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(action.params ?? {}) };
  for (const input of action.inputs ?? []) {
    const v = inputValue(values, input);
    if (v !== "") out[input.id] = v;
  }
  return out;
}

export interface ShelfEntry {
  moduleId: ModuleId;
  title: string;
  verdict: "establishable" | "never";
  /** Why — the grounding fact, in designer language. */
  reason: string;
  /** The one-click action; present exactly when verdict is "establishable". */
  action?: ShelfAction;
}

const OBJECT_KINDS_NEVER_PERSON: ReadonlySet<string> = new Set(["rock", "prop", "structure", "terrain", "dungeon-entrance"]);

/** Evaluate the shelf for one selection: one entry per non-applied module. */
export function evaluateAddShelf(facts: SelectionFacts): readonly ShelfEntry[] {
  const appliedModules = new Set(evaluateRelevance(facts).applied.flatMap((w) => w.modules));
  const entries: ShelfEntry[] = [];
  const add = (e: ShelfEntry): void => {
    if (!appliedModules.has(e.moduleId)) entries.push(e);
  };
  const person = isPersonKind(facts) && !OBJECT_KINDS_NEVER_PERSON.has(facts.kind.toLowerCase());

  // Vendor: attachable to a person-like object; a rock can never sell.
  add({
    moduleId: "vendor",
    title: "Vendor",
    verdict: person ? "establishable" : "never",
    reason: person ? "This character can host a vendor template." : "Only characters and creatures can sell — this kind never hosts a vendor.",
    ...(person
      ? {
          action: {
            label: "Add vendor",
            verb: "attachVendor",
            params: { entity: facts.id, templateId: "" },
            inputs: [{ id: "templateId", label: "Vendor template", kind: "picker", source: "vendor-templates", placeholder: "Choose a template" }],
          },
        }
      : {}),
  });

  // Character sheet: creatures/NPCs can gain a CharacterRef; a plain prop never offers the sheet.
  add({
    moduleId: "character",
    title: "Character",
    verdict: person ? "establishable" : "never",
    reason: person ? "This kind can carry a character record." : "A plain object of this kind never has a character sheet.",
    ...(person ? { action: { label: "Make character", addComponents: ["CharacterRef"] } } : {}),
  });

  // Combat: Health+Stamina addition, for anything that can act or be acted on.
  const canFight = person || facts.hasCollider;
  add({
    moduleId: "combat",
    title: "Combat",
    verdict: canFight ? "establishable" : "never",
    reason: canFight ? "Health and Stamina can be added to this object." : "This kind has no body to give health or stamina to.",
    ...(canFight ? { action: { label: "Add combat", addComponents: ["Health", "Stamina"] } } : {}),
  });

  // Creature: only a spawner can establish creature behaviour on the spot.
  const isSpawner = hasComponent(facts, "Spawner");
  add({
    moduleId: "creatures",
    title: "Creature",
    verdict: isSpawner ? "establishable" : "never",
    reason: isSpawner ? "This spawner can spawn a creature kind here." : "Creature behaviour belongs to spawned creatures and their spawners.",
    ...(isSpawner
      ? {
          action: {
            label: "Spawn creature",
            verb: "spawnCreature",
            params: { kind: "" },
            inputs: [{ id: "kind", label: "Creature kind", kind: "picker", source: "creature-kinds", placeholder: "Choose a kind" }],
          },
        }
      : {}),
  });

  // Physics: any placed object can gain a collider.
  add({
    moduleId: "physics",
    title: "Physics",
    verdict: "establishable",
    reason: "A collider can be added to any placed object.",
    action: { label: "Add collider", addComponents: ["Collider"] },
  });

  // Items: a placed prop can become a world-item fixture where it stands.
  const canFixture = !person && facts.kind.toLowerCase() !== "dungeon-entrance";
  add({
    moduleId: "items",
    title: "Item",
    verdict: canFixture ? "establishable" : "never",
    reason: canFixture ? "This object can be placed as an item fixture." : "Characters hold bags instead of being items; entrances are not items.",
    ...(canFixture ? { action: { label: "Place as item", verb: "placeItemFixture", params: { base: "", rank: "", x: 0, z: 0 } } } : {}),
  });

  // Quests: a person-like object can be marked as a giver.
  add({
    moduleId: "quests",
    title: "Quests & dialogue",
    verdict: person ? "establishable" : "never",
    reason: person ? "This character can be marked as a quest giver." : "Only characters give quests.",
    ...(person ? { action: { label: "Make quest giver", addComponents: ["QuestGiver"] } } : {}),
  });

  // Dungeons: only an entrance-shaped object can become one.
  const entranceKind = facts.kind.toLowerCase() === "portal" || facts.kind.toLowerCase() === "entrance";
  add({
    moduleId: "dungeons",
    title: "Dungeon entrance",
    verdict: entranceKind ? "establishable" : "never",
    reason: entranceKind ? "This portal can be bound to dungeon pools." : "Only portals and entrances open dungeons.",
    ...(entranceKind ? { action: { label: "Make dungeon entrance", addComponents: ["DungeonEntrance"] } } : {}),
  });

  // Intent: players only, by rule.
  const isPlayer = facts.kind.toLowerCase() === "player";
  add({
    moduleId: "intent",
    title: "Intent",
    verdict: isPlayer ? "establishable" : "never",
    reason: isPlayer ? "Player avatars carry per-session intent budgets." : "Intent budgets exist only on player avatars.",
    ...(isPlayer ? { action: { label: "Add intent budgets", addComponents: ["PlayerIntent"] } } : {}),
  });

  // Markers (Phase A): flow / vfx / audio can bind to any placed object.
  for (const [moduleId, title, marker, label] of [
    ["flow", "Flow behaviour", "FlowRef", "Bind flow graph"],
    ["vfx", "Effects", "VfxEmitter", "Add effect emitter"],
    ["audio", "Audio", "AudioEmitter", "Add audio emitter"],
  ] as const) {
    add({
      moduleId,
      title,
      verdict: "establishable",
      reason: `Any placed object can carry a ${marker} marker.`,
      action: { label, addComponents: [marker] },
    });
  }

  return entries;
}

/** The shelf as the UI shows it: establishable entries only — "never" stays hidden. */
export function visibleShelf(facts: SelectionFacts): readonly ShelfEntry[] {
  return evaluateAddShelf(facts).filter((e) => e.verdict === "establishable");
}
