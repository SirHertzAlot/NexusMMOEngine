/**
 * Wildlife and sea life for the ecology: layers built from the art catalog
 * by model NAME pattern, so no licensed model names live in source. A
 * layer's assets are whatever catalog models match its patterns (static
 * models only: a creature that moves needs a simulated agent, which this
 * doesn't build). A kind with no match is left out.
 *
 *   npm run wildlife:plan -w @mmo-engine/engine-core -- [--catalog assets/catalog.json] [--base <plan>] [--out content/ecology/wildlife.local.ecology.json]
 *
 * writes the base plan (default wilds) plus these layers to a gitignored
 * `*.local.ecology.json` (it lists the licensed models by id); run the
 * server with MMO_ECOLOGY=<that file>.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { SpawnArchetype } from "@mmo-engine/scatter";
import { fieldAt, parseEcologyPlan, ramp, type EcologyLayer, type EcologyPlan } from "./ecology.js";
import { loadWildlifeTable, words, type CatalogModel, type WildlifeTable } from "./wildlife-table.js";

export type { CatalogModel };

/** What a wildlife layer places, by name. `names` match whole `_`-separated words (case-insensitive); `not` drops names that also match (body parts). */
export interface WildlifeKind {
  id: string;
  names: string;
  not?: string;
  layer: Omit<EcologyLayer, "id" | "assets">;
}

const NO_BODY = "tail|claw|hand|fin|tooth|slice|flying";
const prop = { category: "prop", collision: { shape: "none", motion: "static" } } as const;

export const WILDLIFE_KINDS: readonly WildlifeKind[] = [
  // Sea floor, below the surface (habitat water, depths in metres below it): sessile flora and fauna.
  { id: "seaFlora", names: "coral|kelp|seaweed|anemone|sea_anemone|sponge", layer: { ...prop, habitat: "water", aboveWater: [-9, -1], place: { kind: "field", spacing: 5 }, chance: 0.4, scale: [0.8, 1.3] } },
  { id: "seaBed", names: "starfish|sea_urchin|urchin|clam|nautilus_shell|crab|lobster|octopus|seahorse", not: NO_BODY, layer: { ...prop, habitat: "water", aboveWater: [-9, -1], place: { kind: "field", spacing: 9 }, chance: 0.25, scale: [0.9, 1.2] } },
  // Free swimmers: fish and sea mammals in the open water, from the surface down to 30 m. Static for now (a mover needs the agent path).
  { id: "freeSwimmers", names: "shark|dolphin|whale|orca|manta|stingray|ray|tuna|salmon|cod|trout|eel|seal|marlin|angelfish|clownfish|goldfish|koi|fish", not: "rack|hook|bone|bowl|fry|fin", layer: { ...prop, habitat: "water", aboveWater: [-30, -1], place: { kind: "field", spacing: 12 }, chance: 0.15, scale: [0.9, 1.2] } },
  // Shore: birds standing at the water line.
  { id: "shoreBirds", names: "pelican|seagull|gull|duck|goose|mallard_duck", not: NO_BODY, layer: { ...prop, habitat: "shore", aboveWater: [-0.2, 0.6], place: { kind: "field", spacing: 14 }, chance: 0.12, scale: [0.9, 1.1] } },
  // Land: ambient wildlife (static), thin in the open, denser in the woods.
  {
    id: "woodlandFauna",
    names: "fox|gray_fox|badger|raccoon|skunk|hedgehog|porcupine|chipmunk|squirrel|rabbit|cottontail_rabbit|weasel|ferret|otter|beaver|deer|mule_deer|elk|boar|wolf|coyote|bobcat|owl|barn_owl|hawk|raven|crow|woodpecker|pheasant|quail|sparrow",
    layer: { ...prop, place: { kind: "field", spacing: 24 }, chance: 0.12, density: [{ field: "forest", ramp: [0.4, 0.6] }], scale: [0.9, 1.15] },
  },
  { id: "critters", names: "frog|tree_frog|salamander|snail|beetle|ladybug|mouse|rat|snake|caterpillar|dragonfly|butterfly", layer: { ...prop, place: { kind: "field", spacing: 8 }, chance: 0.05, biome: "open", scale: [0.9, 1.2] } },
  { id: "farmAnimals", names: "cow|bull|horse|donkey|llama|pig|sheep|goat|turkey|hen|rooster|chick|duck|goose", layer: { ...prop, place: { kind: "field", spacing: 30 }, chance: 0.1, biome: "open", density: [{ field: "meadow", ramp: [0.4, 0.55] }], scale: [0.9, 1.1] } },
];

/** The kind's models: static, name-matched, parts excluded; sorted by id. */
export function kindModels(kind: WildlifeKind, models: readonly CatalogModel[]): CatalogModel[] {
  const yes = words(kind.names);
  const no = kind.not ? words(kind.not) : null;
  return models.filter((m) => !m.skinned && yes.test(m.name) && !(no && no.test(m.name))).sort((a, b) => a.id.localeCompare(b.id));
}

/** One ecology layer per kind that has models, the same weight each. */
export function wildlifeLayers(models: readonly CatalogModel[]): EcologyLayer[] {
  const out: EcologyLayer[] = [];
  for (const k of WILDLIFE_KINDS) {
    const ms = kindModels(k, models);
    if (ms.length > 0) out.push({ id: k.id, ...k.layer, assets: ms.map((m) => ({ asset: m.id, weight: 1 })) });
  }
  return out;
}

/** Spawn-table archetypes for the water kinds, for the scatter path (asset id -> habitat water with depths). */
export function wildlifeArchetypes(models: readonly CatalogModel[]): Record<string, SpawnArchetype> {
  const out: Record<string, SpawnArchetype> = {};
  for (const k of WILDLIFE_KINDS) {
    if (k.layer.habitat !== "water" || !k.layer.aboveWater) continue;
    const [lo, hi] = k.layer.aboveWater;
    for (const m of kindModels(k, models)) out[m.id] = { asset: m.id, category: "prop", habitat: "water", depthM: [-(hi ?? 0), -lo], collision: { shape: "none", motion: "static" } };
  }
  return out;
}

/** The plan with the wildlife layers added; `avoid` trees and the fields they read are only used where the plan has them. Returns a validated copy. */
export function withWildlife(plan: EcologyPlan, models: readonly CatalogModel[]): EcologyPlan {
  const have = new Set(plan.layers.map((l) => l.id));
  const layers = wildlifeLayers(models)
    .filter((l) => !have.has(l.id))
    .map((l) => ({ ...l, ...(l.habitat === undefined && have.has("trees") ? { avoid: { trees: 3 } } : {}) }))
    .filter((l) => (l.density ?? []).every((d) => plan.fields[d.field]));
  return parseEcologyPlan({ ...plan, layers: [...plan.layers, ...layers] });
}

// -------------------------------------------------------------- megaflora

const pascal = (id: string): string => id.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");

/**
 * One ecology layer per megaflora entry of the table that has static catalog models. The scale is the
 * table's (over the model's natural size, on top of the global category dial), a trunk blocks only a thin
 * share of its footprint and fronds and caps do not block at all, and groves follow the `megaGrove` field
 * that `withMegaflora` adds. Each layer reads the biome group named after itself, so its biome weights are its own.
 */
export function megafloraLayers(t: WildlifeTable, models: readonly CatalogModel[]): EcologyLayer[] {
  const out: EcologyLayer[] = [];
  for (const [id, f] of Object.entries(t.megaflora ?? {})) {
    const yes = words(f.names), no = f.not ? words(f.not) : null;
    const ms = models.filter((m) => !m.skinned && yes.test(m.name) && !(no && no.test(m.name))).sort((a, b) => a.id.localeCompare(b.id));
    if (ms.length === 0) continue;
    const layerId = `mega${pascal(id)}`;
    out.push({
      id: layerId,
      category: f.kind === "tree" ? "tree" : "plant",
      place: { kind: "field", spacing: f.kind === "tree" ? 14 : 9 },
      chance: 0.35,
      ...(f.groves ? { density: [{ field: "megaGrove", ramp: [0.45, 0.6] as [number, number] }] } : {}),
      biome: layerId,
      scale: f.scale,
      collision: f.collision === "trunk" ? { shape: "box", fit: 0.15, motion: "static" } : { shape: "none", motion: "static" },
      assets: ms.map((m) => ({ asset: m.id, weight: 1 })),
    });
  }
  return out;
}

const MEGA_GROVE = { scale: 220, octaves: 3, seed: 7717 } as const;

/** The plan with the megaflora layers, the `megaGrove` field and each layer's biome weights (zero in every biome the table does not list). Returns a validated copy. */
export function withMegaflora(plan: EcologyPlan, t: WildlifeTable, models: readonly CatalogModel[]): EcologyPlan {
  const have = new Set(plan.layers.map((l) => l.id));
  const layers = megafloraLayers(t, models).filter((l) => !have.has(l.id));
  if (layers.length === 0) return parseEcologyPlan(JSON.parse(JSON.stringify(plan)));
  const biomes: EcologyPlan["biomes"] = JSON.parse(JSON.stringify(plan.biomes));
  biomes.default ??= {};
  for (const [id, f] of Object.entries(t.megaflora ?? {})) {
    const layerId = `mega${pascal(id)}`;
    if (!layers.some((l) => l.id === layerId)) continue;
    biomes.default[layerId] = 0;
    for (const [b, w] of Object.entries(f.biomes)) (biomes[b] ??= {})[layerId] = w;
  }
  return parseEcologyPlan({ ...plan, fields: { ...plan.fields, megaGrove: plan.fields.megaGrove ?? { ...MEGA_GROVE } }, biomes, layers: [...plan.layers, ...layers] });
}

/** How much megaflora grove stands at (x, z), 0 to 1: pass it as `groveAt` to `planMegafauna`. 0 where the plan has no grove field. */
export function megaGroveAt(plan: EcologyPlan, x: number, z: number): number {
  const f = plan.fields.megaGrove;
  return f ? ramp(fieldAt(f, x, z), [0.45, 0.6]) : 0;
}

// ------------------------------------------------------------------- CLI

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (n: string): string | undefined => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const root = fileURLToPath(new URL("../../../../../", import.meta.url));
  const catalog = JSON.parse(readFileSync(flag("--catalog") ?? `${root}assets/catalog.json`, "utf8")) as { models: CatalogModel[] };
  const base = JSON.parse(readFileSync(flag("--base") ?? `${root}packages/engine-core/content/ecology/wilds.ecology.json`, "utf8")) as EcologyPlan;
  const out = flag("--out") ?? `${root}packages/engine-core/content/ecology/wildlife.local.ecology.json`;
  const table = loadWildlifeTable(flag("--table"));
  const plan = withMegaflora(withWildlife(base, catalog.models), table, catalog.models);
  writeFileSync(out, JSON.stringify({ ...plan, name: `${plan.name}+wildlife` }, null, 1));
  const added = plan.layers.slice(base.layers.length);
  console.log(`[wildlife] ${added.map((l) => `${l.id} ${l.assets.length}`).join(", ") || "no layers (no matching models)"} -> ${out} (gitignored; MMO_ECOLOGY=<that file>)`);
}
