/**
 * Wildlife as data: who lives where, in what numbers and how dangerous, from
 * what the real animal does (docs/WILDLIFE.md). Every number lives in
 * `content/wildlife/wildlife.json`; this file is its schema, its ratio and
 * safety checks, and a pure per-chunk planner.
 *
 *  - Ratios come from the trophic pyramid: per biome the predators are a
 *    small share of the prey, by individuals (`ratios`), apex rarer still.
 *  - Danger ramps with distance from the nearest centre (the spawn, the
 *    settlements): `rings` say the highest danger tier allowed from each
 *    distance, and nothing of tier 2 or more stands within `safeRadiusM`.
 *    Tiers: 0 harmless, 1 defends itself only, 2 solitary and telegraphed,
 *    3 packs and big hunters, 4 apex.
 *  - Livestock lives only in a ring round settlement centres.
 *  - Aquatic species stand in water within `depthM` of the surface.
 *
 * Species ids are generic; which art models show a species is `models`, a
 * list of whole name words matched against the local catalog (see
 * `speciesModels`), written to a gitignored file.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hash } from "./ecology.js";

export const ROLES = ["apex_predator", "mesopredator", "large_herbivore", "small_prey", "scavenger", "livestock", "aquatic"] as const;
export const TEMPERAMENTS = ["flee", "defend", "territorial", "hunt"] as const;
export const ACTIVITIES = ["diurnal", "nocturnal", "crepuscular", "cathemeral"] as const;
export const GROUPS = ["solitary", "pair", "herd", "flock", "pack", "shoal"] as const;

const size = z.tuple([z.number().int().min(1), z.number().int().min(1)]).refine(([a, b]) => a <= b, "group size: min above max");

export const SpeciesSchema = z.strictObject({
  role: z.enum(ROLES),
  /** Counts toward predators, prey or neither in the ratios; default from the role (aquatic species say). */
  trophic: z.enum(["predator", "prey", "other"]).optional(),
  /** Counts toward the apex ratio. */
  apex: z.boolean().optional(),
  /** Whole name words (`_`-separated, case-insensitive, `a|b`) matching art catalog names. Generic words only. */
  models: z.string().min(1),
  habitat: z.enum(["land", "shore", "water"]),
  /** habitat water: depths it lives at, [shallowest, deepest] metres below the surface. */
  depthM: z.tuple([z.number().min(0), z.number().positive()]).optional(),
  group: z.strictObject({ kind: z.enum(GROUPS), size }),
  /** Radius it ranges over from home, metres. */
  territoryM: z.number().positive(),
  activity: z.enum(ACTIVITIES),
  temperament: z.enum(TEMPERAMENTS),
  danger: z.strictObject({
    /** 0 harmless, 1 defends itself only, 2 solitary and telegraphed, 3 packs and big hunters, 4 apex. */
    tier: z.number().int().min(0).max(4),
    health: z.number().positive(),
    /** Damage per blow as a multiple of a goblin's. */
    damageX: z.number().min(0),
    /** Metres at which it notices a player: flees (flee), warns (defend, territorial) or gives chase (hunt). */
    noticeM: z.number().min(0),
    /** Seconds of visible warning (growl, rear up, hiss) before it attacks; 0 for harmless ones. */
    telegraphS: z.number().min(0),
    tactics: z.enum(["none", "ambush", "flank"]),
  }),
  /** Biome id -> how many of its groups there are, relative to the others in that biome. */
  biomes: z.record(z.string(), z.number().min(0)),
  note: z.string().default(""),
}).refine((s) => s.habitat !== "water" || s.depthM !== undefined, { message: "habitat water needs depthM", path: ["depthM"] })
  .refine((s) => s.role !== "aquatic" || s.habitat === "water" || s.habitat === "shore", { message: "aquatic species live in or by the water", path: ["habitat"] });

const range = z.tuple([z.number().min(0), z.number().min(0)]).refine(([a, b]) => a <= b, "range: min above max");

export const WildlifeTableSchema = z.strictObject({
  version: z.literal(1),
  /** Nothing of danger tier 2 or more stands this close to a spawn or settlement centre, metres. */
  safeRadiusM: z.number().min(0),
  /** From this distance to the nearest centre, the highest danger tier allowed. Sorted by fromM, the first at 0. */
  rings: z.array(z.strictObject({ fromM: z.number().min(0), maxDanger: z.number().int().min(0).max(4) })).min(1),
  livestock: z.strictObject({ radiusM: range, packsPerKm2: z.number().min(0) }),
  /** More animals near water: up to `1 + boost` times the density at the water line, fading over `rangeM`. */
  waterProximity: z.strictObject({ rangeM: z.number().positive(), boost: z.number().min(0) }),
  ratios: z.strictObject({
    /** Predator individuals per prey individual, per biome: [min, max]. */
    predatorToPrey: range,
    apexToPrey: range,
  }),
  biomes: z.record(z.string(), z.strictObject({ packsPerKm2: z.number().min(0), fertility: z.number().min(0) })),
  species: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SpeciesSchema),
});
export type WildlifeTable = z.infer<typeof WildlifeTableSchema>;
export type Species = z.infer<typeof SpeciesSchema>;

export const DEFAULT_WILDLIFE_TABLE = fileURLToPath(new URL("../../../content/wildlife/wildlife.json", import.meta.url));

const trophicOf = (s: Species): "predator" | "prey" | "other" =>
  s.trophic ?? (s.role === "apex_predator" || s.role === "mesopredator" ? "predator" : s.role === "large_herbivore" || s.role === "small_prey" ? "prey" : "other");
const isApex = (s: Species): boolean => s.role === "apex_predator" || s.apex === true;
const meanGroup = (s: Species): number => (s.group.size[0] + s.group.size[1]) / 2;

/** Individuals per biome by trophic level (livestock excluded: it follows settlements, not the pyramid). */
export function biomeCounts(t: WildlifeTable, biome: string): { prey: number; predator: number; apex: number } {
  const out = { prey: 0, predator: 0, apex: 0 };
  for (const s of Object.values(t.species)) {
    if (s.role === "livestock") continue;
    const n = (s.biomes[biome] ?? 0) * meanGroup(s);
    const tr = trophicOf(s);
    if (tr === "prey") out.prey += n;
    else if (tr === "predator") { out.predator += n; if (isApex(s)) out.apex += n; }
  }
  return out;
}

/** Every problem with a table: pyramid ratios per biome, safe radius against the rings, aquatic and livestock rules. Empty when sound. */
export function checkWildlife(t: WildlifeTable): string[] {
  const out: string[] = [];
  const rings = t.rings;
  if (rings[0]!.fromM !== 0) out.push("rings: the first must start at 0");
  rings.forEach((r, i) => { if (i > 0 && r.fromM <= rings[i - 1]!.fromM) out.push(`rings[${i}]: fromM must increase`); if (i > 0 && r.maxDanger < rings[i - 1]!.maxDanger) out.push(`rings[${i}]: maxDanger must not fall with distance`); });
  for (const r of rings) if (r.maxDanger >= 2 && r.fromM < t.safeRadiusM) out.push(`rings: tier ${r.maxDanger} allowed from ${r.fromM} m, inside safeRadiusM ${t.safeRadiusM}`);
  for (const [id, s] of Object.entries(t.species)) {
    if (s.role === "livestock" && s.danger.tier > 1) out.push(`species ${id}: livestock above tier 1`);
    if (s.temperament === "flee" && s.danger.tier > 1) out.push(`species ${id}: a fleeing species above tier 1`);
    if (s.danger.tier >= 2 && s.danger.telegraphS <= 0) out.push(`species ${id}: tier ${s.danger.tier} needs a telegraph (telegraphS > 0), the first challenge must be learnable`);
    if (s.depthM && s.depthM[0] >= s.depthM[1]) out.push(`species ${id}: depthM shallowest must be above deepest`);
    for (const b of Object.keys(s.biomes)) if (!t.biomes[b]) out.push(`species ${id}: unknown biome "${b}"`);
  }
  for (const b of Object.keys(t.biomes)) {
    const c = biomeCounts(t, b);
    if (c.prey === 0) { if (c.predator > 0) out.push(`biome ${b}: predators with no prey`); continue; }
    const r = c.predator / c.prey;
    if (r < t.ratios.predatorToPrey[0] || r > t.ratios.predatorToPrey[1]) out.push(`biome ${b}: predator:prey ${r.toFixed(3)} outside [${t.ratios.predatorToPrey.join(", ")}]`);
    const a = c.apex / c.prey;
    if (a < t.ratios.apexToPrey[0] || a > t.ratios.apexToPrey[1]) out.push(`biome ${b}: apex:prey ${a.toFixed(3)} outside [${t.ratios.apexToPrey.join(", ")}]`);
  }
  return out;
}

export function parseWildlifeTable(json: unknown): WildlifeTable {
  const t = WildlifeTableSchema.parse(json);
  const problems = checkWildlife(t);
  if (problems.length > 0) throw new Error(`wildlife table: ${problems.join("; ")}`);
  return t;
}

export function loadWildlifeTable(file: string = DEFAULT_WILDLIFE_TABLE): WildlifeTable {
  return parseWildlifeTable(JSON.parse(readFileSync(file, "utf8")));
}

// ---------------------------------------------------------------- planner

export interface Centre { x: number; z: number; kind: "spawn" | "settlement" }

export interface WildlifePlanContext {
  seed: number;
  cx: number;
  cz: number;
  chunkWorldSize: number;
  biomeAt: (x: number, z: number) => string | null;
  /** Spawn and settlement centres: danger ramps up with the distance to the nearest, livestock rings the settlements. */
  centres: readonly Centre[];
  /** Metres of water over the ground at (x, z); null or 0: dry land. Default: all dry. */
  depthAt?: (x: number, z: number) => number | null;
  /** Metres to the nearest water. Default: none known (no boost). */
  waterDistanceAt?: (x: number, z: number) => number;
  /** Which species may spawn (have creature rules). Default: all. */
  spawnable?: (species: string) => boolean;
}

export interface WildlifePack { kind: string; biome: string; x: number; z: number; pack: [number, number]; tier: number; }

const unit = (h: number): number => h / 4294967296;
const SALT = 0x71d1;
/** Land content stands at least this far above the water; shore animals within this of it (metres). */
const SHORE_M = 15;

/** Highest danger tier allowed `d` metres from the nearest centre. */
export function maxDangerAt(t: WildlifeTable, d: number): number {
  let m = t.rings[0]!.maxDanger;
  for (const r of t.rings) if (d >= r.fromM) m = r.maxDanger;
  return d < t.safeRadiusM ? Math.min(m, 1) : m;
}

function nearest(centres: readonly Centre[], x: number, z: number, kind?: Centre["kind"]): number {
  let best = Infinity;
  for (const c of centres) if (!kind || c.kind === kind) best = Math.min(best, Math.hypot(c.x - x, c.z - z));
  return best;
}

function pick(items: Array<[string, number]>, r: number): string | null {
  let total = 0;
  for (const [, w] of items) total += w;
  if (total <= 0) return null;
  let u = r * total;
  for (const [id, w] of items) { u -= w; if (u < 0) return id; }
  return items[items.length - 1]![0];
}

/**
 * The wildlife one chunk holds, at most one wild group and one livestock group, drawn at points in the chunk.
 * Pure: the same inputs give the same groups. A wild group's biome density is scaled by fertility and by
 * water proximity; its species is drawn by weight from those that suit the spot (habitat, depth) and whose
 * danger tier the ring at that distance allows. Livestock appears only in the ring round settlements.
 */
export function planWildlifeChunk(t: WildlifeTable, ctx: WildlifePlanContext): WildlifePack[] {
  const s = ctx.chunkWorldSize;
  const out: WildlifePack[] = [];
  const ok = ctx.spawnable ?? (() => true);
  for (const livestock of [false, true]) {
    const k = livestock ? 10 : 0;
    const x = (ctx.cx + unit(hash(ctx.seed, SALT, ctx.cx, ctx.cz, 1 + k))) * s;
    const z = (ctx.cz + unit(hash(ctx.seed, SALT, ctx.cx, ctx.cz, 2 + k))) * s;
    const biome = ctx.biomeAt(x, z);
    if (biome === null) continue;
    const entry = t.biomes[biome];
    const depth = ctx.depthAt?.(x, z) ?? 0;
    const wet = depth > 0;
    const dAny = nearest(ctx.centres, x, z);
    let perKm2: number;
    if (livestock) {
      const dSettle = nearest(ctx.centres, x, z, "settlement");
      if (!(dSettle >= t.livestock.radiusM[0] && dSettle <= t.livestock.radiusM[1]) || wet) continue;
      perKm2 = t.livestock.packsPerKm2;
    } else {
      if (!entry) continue;
      const wd = ctx.waterDistanceAt ? ctx.waterDistanceAt(x, z) : Infinity;
      perKm2 = entry.packsPerKm2 * entry.fertility * (1 + t.waterProximity.boost * Math.max(0, 1 - wd / t.waterProximity.rangeM));
    }
    const chance = Math.min(1, (perKm2 * s * s) / 1e6);
    if (unit(hash(ctx.seed, SALT, ctx.cx, ctx.cz, 3 + k)) >= chance) continue;
    const maxTier = maxDangerAt(t, dAny);
    const nearWater = (ctx.waterDistanceAt ? ctx.waterDistanceAt(x, z) : Infinity) <= SHORE_M;
    const cands: Array<[string, number]> = [];
    for (const [id, sp] of Object.entries(t.species)) {
      if ((sp.role === "livestock") !== livestock || !ok(id)) continue;
      const w = sp.biomes[biome] ?? 0;
      if (w <= 0 || sp.danger.tier > maxTier) continue;
      if (sp.habitat === "water" ? !(wet && depth >= sp.depthM![0] && depth <= sp.depthM![1]) : wet) continue;
      if (sp.habitat === "shore" && !nearWater) continue;
      cands.push([id, w]);
    }
    const id = pick(cands, unit(hash(ctx.seed, SALT, ctx.cx, ctx.cz, 4 + k)));
    if (id === null) continue;
    const sp = t.species[id]!;
    out.push({ kind: id, biome, x, z, pack: [sp.group.size[0], sp.group.size[1]], tier: sp.danger.tier });
  }
  return out;
}

// ------------------------------------------------------------ art mapping

export interface CatalogModel { id: string; name: string; skinned: boolean }

const words = (src: string): RegExp => new RegExp(`(^|_)(${src})(_|$)`, "i");

/** Species id -> the catalog model ids that depict it (by `models` name words), sorted. Species with none are left out. */
export function speciesModels(t: WildlifeTable, models: readonly CatalogModel[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, sp] of Object.entries(t.species)) {
    const re = words(sp.models);
    const ids = models.filter((m) => re.test(m.name)).map((m) => m.id).sort();
    if (ids.length > 0) out[id] = ids;
  }
  return out;
}

// ------------------------------------------------------------------- CLI

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (n: string): string | undefined => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const root = fileURLToPath(new URL("../../../../../", import.meta.url));
  const t = loadWildlifeTable(flag("--table"));
  const catalog = JSON.parse(readFileSync(flag("--catalog") ?? `${root}assets/catalog.json`, "utf8")) as { models: CatalogModel[] };
  const out = flag("--out") ?? `${root}packages/engine-core/content/wildlife/models.local.json`;
  const map = speciesModels(t, catalog.models);
  writeFileSync(out, JSON.stringify(map, null, 1));
  const missing = Object.keys(t.species).filter((k) => !map[k]);
  console.log(`[wildlife] ${Object.keys(map).length} of ${Object.keys(t.species).length} species have models -> ${out} (gitignored)${missing.length ? `; none for ${missing.join(", ")}` : ""}`);
}
