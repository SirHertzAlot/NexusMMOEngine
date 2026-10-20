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
 *    3 packs and big hunters, 4 apex, 5 boss (megafauna: rare, instinct-driven
 *    giants of the prehistoric record, see `species.*.boss` and `megafauna`).
 *  - Bosses (tier 5) are outside the pyramid and the per-chunk planner: they are
 *    few per world (`megafauna.maxPerWorld`, `rarityPer100Km2`), placed by
 *    `planMegafauna` (megafauna.ts), and raid big settlements by `raid` rules.
 *    Megaflora (`megaflora`) are giant ancient plants as ecology layers.
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
import { bossModels } from "./megafauna.js";

export const ROLES = ["apex_predator", "mesopredator", "large_herbivore", "small_prey", "scavenger", "livestock", "aquatic"] as const;
export const TEMPERAMENTS = ["flee", "defend", "territorial", "hunt"] as const;
export const ACTIVITIES = ["diurnal", "nocturnal", "crepuscular", "cathemeral"] as const;
export const GROUPS = ["solitary", "pair", "herd", "flock", "pack", "shoal"] as const;

export const BOSS_DRIVES = ["hunger", "territory", "scent_blood", "scent_food", "scent_livestock", "noise", "season"] as const;
export const RAID_TARGETS = ["livestock", "structures", "players", "boats"] as const;
export const RAID_APPROACHES = ["habitat_edge", "along_water", "direct"] as const;
export const WARNING_SIGNS = ["tracks", "carcass", "claw_marks", "wake", "noise", "bones"] as const;
/** Megaflora scale multipliers over the model's natural size: below 1.5 is not giant, above 8 is a typo. */
export const MEGAFLORA_SCALE: readonly [number, number] = [1.5, 8];

const pair = z.tuple([z.number().int().min(1), z.number().int().min(1)]).refine(([a, b]) => a <= b, "count: min above max");

const RaidSchema = z.strictObject({
  /** A settlement is a target only at or above all of these (zero: no minimum). */
  minPopulation: z.number().min(0),
  minStructures: z.number().min(0).default(0),
  minLivestock: z.number().min(0).default(0),
  minFoodStores: z.number().min(0).default(0),
  /** Metres from the lair to the settlement. */
  rangeM: z.number().positive(),
  /** Seconds between raids by one boss. */
  cooldownS: z.number().positive(),
  /** habitat_edge: out of its biome's edge nearest the town; along_water: by river, lake or sea (waterside towns only); direct: straight from the lair. */
  approach: z.enum(RAID_APPROACHES),
  targets: z.array(z.enum(RAID_TARGETS)).min(1),
  /** It leaves when fed (meals of livestock or people), hurt below hpBelowPct of its health, or after maxS seconds. */
  retreat: z.strictObject({ satiatedMeals: z.number().int().min(1), hpBelowPct: z.number().min(0).max(100), maxS: z.number().positive() }),
  /** What the town can find beforehand, spawned as dressing near the approach: `leadS` seconds before it arrives, within `radiusM` of the town. */
  warningSigns: z.array(z.strictObject({ kind: z.enum(WARNING_SIGNS), radiusM: z.number().positive(), leadS: z.number().min(0) })).min(1),
  /** A raid may target a settlement inside the starter safe radius only when this says so. */
  allowInsideSafeRadius: z.boolean().optional(),
});
export type Raid = z.infer<typeof RaidSchema>;

export const BossSchema = z.strictObject({
  /** Body length and height in metres (nose to tail base; shoulder or standing height). */
  lengthM: z.number().min(3).max(30),
  heightM: z.number().min(1).max(15),
  /** The closest existing species whose model is scaled up when no model matches `models`, and that model's natural length. */
  base: z.strictObject({ species: z.string(), lengthM: z.number().positive() }),
  /** Whole name words dropped from the `models` matches (body parts, props). */
  modelsNot: z.string().optional(),
  /** Speed on land, as a multiple of a player's sprint (land and shore bosses). */
  speedX: z.number().positive().optional(),
  /** Speed in water, as a multiple of a player's sprint (water bosses; shore bosses may swim). */
  swimSpeedX: z.number().positive().optional(),
  lair: z.strictObject({ radiusM: z.number().positive(), /** 0..1: how much its lair leans to megaflora groves. */ floraBias: z.number().min(0).max(1).default(0) }),
  /** World spawns per 100 km2: very rare. */
  rarityPer100Km2: z.number().positive(),
  /** Loot table id for the creature rules to use. */
  loot: z.string().min(1),
  /** Instinct only: no planning, no talking, no bargaining. */
  intelligence: z.literal(0),
  /** What drives it, as tags for the brain: it acts on these and nothing else. */
  drives: z.array(z.enum(BOSS_DRIVES)).min(1),
  weakPoints: z.array(z.strictObject({ part: z.string().min(1), damageMult: z.number().min(1), staggerS: z.number().min(0).default(0) })).optional(),
  /** Smaller species that run with it (dire wolf and its pack). */
  escort: z.strictObject({ species: z.string(), count: pair }).optional(),
  raid: RaidSchema.optional(),
});
export type Boss = z.infer<typeof BossSchema>;

const rangeNum = z.tuple([z.number().min(0), z.number().min(0)]).refine(([a, b]) => a <= b, "range: min above max");

/** World-level bounds every boss is checked against. */
export const MegafaunaRulesSchema = z.strictObject({
  /** At most this many bosses stand in one world. */
  maxPerWorld: z.number().int().min(0),
  maxRarityPer100Km2: z.number().positive(),
  /** The sum over all bosses. */
  totalRarityPer100Km2: z.number().positive(),
  /** Boss groups per predator group in a biome it lives in: [min, max]. */
  bossToPredator: rangeNum,
  /** Reference creature strengths (health) the boss scale is read against; not shipped creatures. */
  yardsticks: z.strictObject({ goblin: z.number().positive(), orc: z.number().positive(), troll: z.number().positive(), golem: z.number().positive() }),
  /** Boss health in trolls of health: [min, max]. */
  healthTrolls: rangeNum,
  /** Boss damageX: [min, max]. */
  damageX: rangeNum,
  minTelegraphS: z.number().positive(),
  minSpeedX: z.number().positive(),
  minSwimSpeedX: z.number().positive(),
  raidMinPopulation: z.number().min(0),
  raidCooldownMinS: z.number().positive(),
  /** Lairs keep this far apart, and this far from settlements. */
  minSeparationM: z.number().min(0),
  lairMinFromSettlementM: z.number().min(0),
  /** Body length over the base model's length: the model scale. */
  maxModelScale: z.number().positive(),
});
export type MegafaunaRules = z.infer<typeof MegafaunaRulesSchema>;

export const MEGAFLORA_KINDS = ["fern", "tree", "fungus", "carnivorous"] as const;

/** A giant ancient plant as an ecology layer: scale over the model's natural size, trunk collision, biome weights. */
export const MegafloraSchema = z.strictObject({
  kind: z.enum(MEGAFLORA_KINDS),
  /** Whole name words matched against catalog models (like species `models`). */
  names: z.string().min(1),
  not: z.string().optional(),
  scale: z.tuple([z.number(), z.number()]).refine(([a, b]) => a <= b && a >= MEGAFLORA_SCALE[0] && b <= MEGAFLORA_SCALE[1], `scale: ${MEGAFLORA_SCALE[0]} to ${MEGAFLORA_SCALE[1]} times natural size, min first`),
  /** trunk: only a thin share of the footprint blocks; none: fronds and caps are walked through. */
  collision: z.enum(["none", "trunk"]),
  /** Biome id -> relative weight; absent biomes get none. */
  biomes: z.record(z.string(), z.number().min(0)),
  /** Grows in groves (a noise field) and not scattered; lairs lean toward the groves. */
  groves: z.boolean(),
  /** Carnivorous plants hurt whoever stands in reach, after a warning. */
  hazard: z.strictObject({ radiusM: z.number().positive(), damageX: z.number().positive(), telegraphS: z.number().positive() }).optional(),
}).refine((f) => f.kind !== "carnivorous" || f.hazard !== undefined, { message: "carnivorous megaflora needs a hazard", path: ["hazard"] });
export type Megaflora = z.infer<typeof MegafloraSchema>;

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
    /** 0 harmless, 1 defends itself only, 2 solitary and telegraphed, 3 packs and big hunters, 4 apex, 5 boss (needs `boss`). */
    tier: z.number().int().min(0).max(5),
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
  /** Tier 5 only: the megafauna block (size, speed, lair, rarity, drives, raid). */
  boss: BossSchema.optional(),
  note: z.string().default(""),
}).refine((s) => s.habitat !== "water" || s.depthM !== undefined, { message: "habitat water needs depthM", path: ["depthM"] })
  .refine((s) => s.role !== "aquatic" || s.habitat === "water" || s.habitat === "shore", { message: "aquatic species live in or by the water", path: ["habitat"] });

const range = z.tuple([z.number().min(0), z.number().min(0)]).refine(([a, b]) => a <= b, "range: min above max");

export const WildlifeTableSchema = z.strictObject({
  version: z.literal(1),
  /** Nothing of danger tier 2 or more stands this close to a spawn or settlement centre, metres. */
  safeRadiusM: z.number().min(0),
  /** From this distance to the nearest centre, the highest danger tier allowed. Sorted by fromM, the first at 0. */
  rings: z.array(z.strictObject({ fromM: z.number().min(0), maxDanger: z.number().int().min(0).max(5) })).min(1),
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
  /** World-level bounds for the tier-5 bosses; required when a species has a `boss`. */
  megafauna: MegafaunaRulesSchema.optional(),
  /** Giant ancient plants by id. */
  megaflora: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), MegafloraSchema).optional(),
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
    if (s.role === "livestock" || s.boss) continue;
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
    if (s.danger.tier === 5 && !s.boss) out.push(`species ${id}: tier 5 needs a boss block`);
    if (s.boss && s.danger.tier !== 5) out.push(`species ${id}: a boss block needs tier 5`);
  }
  out.push(...checkMegafauna(t));
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

const sumWeights = (t: WildlifeTable, biome: string, only?: (s: Species) => boolean): number =>
  Object.values(t.species).reduce((a, s) => a + (s.role === "livestock" || s.boss || (only && !only(s)) ? 0 : s.biomes[biome] ?? 0), 0);

/** Problems with the tier-5 bosses and the megaflora: rarity, strength against the troll yardstick, speed, depths, scale, raids, rings. */
export function checkMegafauna(t: WildlifeTable): string[] {
  const out: string[] = [];
  const bosses = Object.entries(t.species).filter((e): e is [string, Species & { boss: Boss }] => e[1].boss !== undefined);
  const m = t.megafauna;
  if (bosses.length > 0 && !m) return ["megafauna: bosses need a megafauna rules block"];
  if (m && bosses.length > 0) {
    if (!t.rings.some((r) => r.maxDanger >= 5)) out.push("rings: no ring allows tier 5, so no boss could stand anywhere");
    let total = 0;
    for (const [id, s] of bosses) {
      const b = s.boss, d = s.danger;
      total += b.rarityPer100Km2;
      if (b.rarityPer100Km2 > m.maxRarityPer100Km2) out.push(`species ${id}: rarity ${b.rarityPer100Km2} per 100 km2 above ${m.maxRarityPer100Km2}`);
      const trolls = d.health / m.yardsticks.troll;
      if (trolls < m.healthTrolls[0] || trolls > m.healthTrolls[1]) out.push(`species ${id}: health ${d.health} is ${trolls.toFixed(1)} trolls, outside [${m.healthTrolls.join(", ")}]`);
      if (d.damageX < m.damageX[0] || d.damageX > m.damageX[1]) out.push(`species ${id}: damageX ${d.damageX} outside [${m.damageX.join(", ")}]`);
      if (d.telegraphS < m.minTelegraphS) out.push(`species ${id}: boss telegraphS ${d.telegraphS} below ${m.minTelegraphS}`);
      const base = t.species[b.base.species];
      if (!base || base.boss) out.push(`species ${id}: base "${b.base.species}" must be an existing non-boss species`);
      const scale = b.lengthM / b.base.lengthM;
      if (scale > m.maxModelScale) out.push(`species ${id}: model scale ${scale.toFixed(1)} above ${m.maxModelScale}`);
      if (b.escort) { const e = t.species[b.escort.species]; if (!e || e.boss) out.push(`species ${id}: escort "${b.escort.species}" must be an existing non-boss species`); }
      if (s.habitat === "water") {
        if (b.swimSpeedX === undefined || b.swimSpeedX < m.minSwimSpeedX) out.push(`species ${id}: a water boss needs a swim speed of at least ${m.minSwimSpeedX} (swimSpeedX)`);
        if (s.depthM && s.depthM[1] < b.lengthM) out.push(`species ${id}: depth ${s.depthM[1]} m is shallower than its ${b.lengthM} m body`);
      } else {
        if (s.role === "aquatic") out.push(`species ${id}: an aquatic boss must live in the water (habitat water)`);
        if (b.speedX === undefined || b.speedX < m.minSpeedX) out.push(`species ${id}: boss speed ${b.speedX ?? "unset"} (speedX) below ${m.minSpeedX}, it must outrun a sprinting player`);
      }
      const r = b.raid;
      if (r) {
        if (r.minPopulation < m.raidMinPopulation) out.push(`species ${id}: raid population threshold (minPopulation) ${r.minPopulation} below ${m.raidMinPopulation}, only large settlements are raided`);
        if (r.cooldownS < m.raidCooldownMinS) out.push(`species ${id}: raid cooldown ${r.cooldownS} s below ${m.raidCooldownMinS}`);
        if (s.habitat === "water" && r.approach !== "along_water") out.push(`species ${id}: a water boss raids along_water`);
      }
      for (const bi of Object.keys(s.biomes)) {
        if ((s.biomes[bi] ?? 0) <= 0 || !t.biomes[bi]) continue;
        const e = t.biomes[bi]!;
        const all = sumWeights(t, bi);
        const predGroups = all > 0 ? (e.packsPerKm2 * e.fertility * sumWeights(t, bi, (x) => trophicOf(x) === "predator")) / all : 0;
        const ratio = predGroups > 0 ? b.rarityPer100Km2 / 100 / predGroups : Infinity;
        if (ratio < m.bossToPredator[0] || ratio > m.bossToPredator[1]) out.push(`biome ${bi}: boss:predator ${ratio.toFixed(4)} for ${id} outside [${m.bossToPredator.join(", ")}]`);
      }
    }
    if (total > m.totalRarityPer100Km2) out.push(`megafauna: total rarity ${total.toFixed(2)} per 100 km2 above ${m.totalRarityPer100Km2}`);
  }
  for (const [id, f] of Object.entries(t.megaflora ?? {})) for (const b of Object.keys(f.biomes)) if (!t.biomes[b]) out.push(`megaflora ${id}: unknown biome "${b}"`);
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

export interface WildlifePack { kind: string; biome: string; x: number; z: number; pack: [number, number]; tier: number; aquatic: boolean; }

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
      if ((sp.role === "livestock") !== livestock || sp.boss || !ok(id)) continue;
      const w = sp.biomes[biome] ?? 0;
      if (w <= 0 || sp.danger.tier > maxTier) continue;
      if (sp.habitat === "water" ? !(wet && depth >= sp.depthM![0] && depth <= sp.depthM![1]) : wet) continue;
      if (sp.habitat === "shore" && !nearWater) continue;
      cands.push([id, w]);
    }
    const id = pick(cands, unit(hash(ctx.seed, SALT, ctx.cx, ctx.cz, 4 + k)));
    if (id === null) continue;
    const sp = t.species[id]!;
    out.push({ kind: id, biome, x, z, pack: [sp.group.size[0], sp.group.size[1]], tier: sp.danger.tier, aquatic: sp.habitat === "water" });
  }
  return out;
}

// ------------------------------------------------------------ art mapping

export interface CatalogModel { id: string; name: string; skinned: boolean; /** Natural size in metres [x, y, z], when the catalog has it. */ size?: readonly [number, number, number] }

/** Whole `_`-separated name words, case-insensitive, `a|b` alternatives. */
export const words = (src: string): RegExp => new RegExp(`(^|_)(${src})(_|$)`, "i");

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
  const boss = bossModels(t, catalog.models);
  const bossOut = out.replace(/models\.local\.json$/, "megafauna.local.json");
  writeFileSync(bossOut, JSON.stringify(boss, null, 1));
  const by = (f: string): string[] => Object.entries(boss).filter(([, b]) => b.from === f || (f === "base" && b.from.startsWith("base:"))).map(([k, b]) => (f === "base" ? `${k} (${b.from.slice(5)})` : k));
  console.log(`[megafauna] own model: ${by("own").join(", ") || "-"}; scaled from a base model: ${by("base").join(", ") || "-"}; none: ${by("none").join(", ") || "-"} -> ${bossOut} (gitignored)`);
  console.log(`[wildlife] ${Object.keys(map).length} of ${Object.keys(t.species).length} species have models -> ${out} (gitignored)${missing.length ? `; none for ${missing.join(", ")}` : ""}`);
}
