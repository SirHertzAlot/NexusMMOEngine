/**
 * What a scene node looks like in the viewport, at the size the engine
 * actually spawns it at (roadmap EB1).
 *
 * The viewport used to draw every node as the same 1 m cube, so a wolf, a
 * pine and a longhouse were one grey box each and nothing in the scene read
 * as the thing it is. The sizes here are not invented for the editor: a
 * creature's capsule is the engine's own `CHARACTER_CAPSULE` multiplied by
 * the body scale `CreatureService` spawns it with, and every stand-in is
 * multiplied by the scale document (`content/scale.json`) the server applies
 * where baked objects spawn. The art pack's model, where there is one, wins
 * over both.
 *
 * This module is pure and browser-safe: the engine's tables and the content
 * files arrive as input (read in `scene-visuals-host.ts`) so the rules can
 * be tested without a repo or a build.
 */

import { resolveScale, SCALE_CATEGORIES, type ScaleCategory, type ScaleDoc } from "@mmo-engine/scene";

/** Where a node's drawn size came from, which the viewport says out loud. */
export type VisualBasis = "model" | "capsule" | "stand-in";

export interface NodeVisual {
  shape: "box" | "capsule";
  /** Metres. A box's full extent; a capsule's [diameter, total height, diameter]. */
  size: [number, number, number];
  /** The art pack's servable model URL, when it has one for this id. */
  model: string | null;
  /**
   * The multiplier the engine applies to this object: a creature's body
   * scale, or the scale document's factor for a prop. A loaded model is
   * drawn at its authored size times this, exactly as the server spawns it
   * — never stretched to fit the stand-in box.
   */
  factor: number;
  basis: VisualBasis;
  /** One line for the viewport tooltip: where this size came from. */
  note: string;
}

/**
 * The size a kind of object stands in at before the scale document, when
 * there is no model to measure. Chosen to read at a glance against a 1.8 m
 * character — never presented as the object's real size (`basis` says
 * "stand-in", and the note says so too).
 */
export const STAND_IN_SIZE: Readonly<Record<ScaleCategory, readonly [number, number, number]>> = Object.freeze({
  building: [8, 5, 8],
  tree: [1.4, 6, 1.4],
  rock: [1.6, 1.2, 1.6],
  plant: [0.6, 0.8, 0.6],
  prop: [1, 1, 1],
});

export interface VisualsInput {
  /** `content/rules/creatures.json`'s creatures, read for `behavior.size`. */
  creatures: Readonly<Record<string, { behavior?: { size?: unknown } } | undefined>>;
  /** engine-core's `SPECIES_NATURAL_SCALE`. */
  naturalScale: Readonly<Record<string, number>>;
  /** engine-core's `CHARACTER_CAPSULE`. */
  capsule: { radius: number; halfHeight: number };
  /** The spawn table's archetypes: id → its scale category. */
  archetypes: Readonly<Record<string, { category?: unknown } | undefined>>;
  /** `content/scale.json`. */
  scale: ScaleDoc;
  /** The art pack's URL for an id, or null when the pack has no model for it. */
  model: (id: string) => string | null;
}

const isCategory = (v: unknown): v is ScaleCategory =>
  typeof v === "string" && (SCALE_CATEGORIES as readonly string[]).includes(v);

const round = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * The body scale `CreatureService.spawnOne` gives a creature: its own
 * `behavior.size` when it sets one, else the species' natural scale, else 1
 * (an unlisted humanoid stands 1.8 m, which is what the capsule already is).
 */
export function creatureBodyScale(
  id: string,
  creatures: VisualsInput["creatures"],
  naturalScale: VisualsInput["naturalScale"],
): number {
  const own = creatures[id]?.behavior?.size;
  if (typeof own === "number" && Number.isFinite(own) && own > 0 && own !== 1) return own;
  const natural = naturalScale[id];
  return typeof natural === "number" && Number.isFinite(natural) && natural > 0 ? natural : 1;
}

/** The capsule the engine spawns a creature with, as a drawable size. */
export function creatureVisual(id: string, input: VisualsInput): NodeVisual {
  const scale = creatureBodyScale(id, input.creatures, input.naturalScale);
  const r = input.capsule.radius * scale;
  const height = (input.capsule.halfHeight + input.capsule.radius) * 2 * scale;
  const model = input.model(id);
  return {
    shape: "capsule",
    size: [round(r * 2), round(height), round(r * 2)],
    model,
    factor: round(scale),
    basis: model ? "model" : "capsule",
    note: model
      ? `${id}: the pack's model, body scale ${round(scale)}`
      : `${id}: the engine's capsule at body scale ${round(scale)} — ${round(height)} m tall`,
  };
}

/** A prop, tree, rock, plant or building: the pack's model, else a category stand-in. */
export function propVisual(id: string, category: ScaleCategory, input: VisualsInput): NodeVisual {
  const factor = resolveScale(input.scale, category, id);
  const base = STAND_IN_SIZE[category];
  const model = input.model(id);
  return {
    shape: "box",
    size: [round(base[0] * factor), round(base[1] * factor), round(base[2] * factor)],
    model,
    factor: round(factor),
    basis: model ? "model" : "stand-in",
    note: model
      ? `${id}: the pack's model, ${category} scale ${round(factor)}`
      : `${id}: no model yet — a ${category} stand-in at scale ${round(factor)}`,
  };
}

/** Every placeable id's visual: the creature roster, then the spawn table's archetypes. */
export function buildVisuals(input: VisualsInput): Record<string, NodeVisual> {
  const out: Record<string, NodeVisual> = {};
  for (const id of Object.keys(input.creatures)) out[id] = creatureVisual(id, input);
  for (const [id, arch] of Object.entries(input.archetypes)) {
    const category = isCategory(arch?.category) ? arch.category : "prop";
    // A creature and an archetype never share an id in practice; if they
    // did, the creature wins, because that is what the scene spawner tries
    // first (scene-spawn.ts resolves `creature` before `prefab`).
    if (!out[id]) out[id] = propVisual(id, category, input);
  }
  return out;
}

/**
 * The ids a scene node could be drawn as, in the order the server resolves
 * them (`scene-spawn.ts`: the Spawner's creature, then the prefab, then the
 * prefab's last path segment, so "camps/goblin" finds the goblin, then the
 * Spawner's species).
 */
export function visualKeys(node: {
  prefab?: string;
  components?: { Spawner?: { creature?: unknown; species?: unknown } };
}): string[] {
  const spawner = node.components?.Spawner;
  const creature = typeof spawner?.creature === "string" ? spawner.creature : "";
  const species = typeof spawner?.species === "string" ? spawner.species : "";
  const prefab = node.prefab ?? "";
  const keys = [creature, prefab, prefab.split("/").pop() ?? "", species].filter((k) => k.length > 0);
  return [...new Set(keys)];
}

/** The node's visual, or null when nothing in the table names it. */
export function visualFor(
  node: Parameters<typeof visualKeys>[0],
  table: Readonly<Record<string, NodeVisual>>,
): NodeVisual | null {
  for (const key of visualKeys(node)) {
    const hit = table[key];
    if (hit) return hit;
  }
  return null;
}
