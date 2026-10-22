/**
 * Dungeon instance content (roadmap D4): content/dungeons/.
 *
 *  - instances.json: the run's rules. These are the proposed defaults for
 *    DUNGEONS-AND-LOOT.md §10's open questions (party size, time limit,
 *    re-entry, what a crash does), kept as data so they change without code;
 *  - entrances.json: where in the open world a party asks for a dungeon,
 *    and which pool layouts that entrance draws from (rank, themes);
 *  - props.json: what each baked prop kind (pillar, brazier, barrel, torch…)
 *    spawns as: the world's spawn table (asset, collision box, category) keyed
 *    by asset id, `dungeon:<kind>`, plus `lift` (by kind), the height a wall- or ceiling-mounted kind hangs at.
 *    Sizes follow the world's convention: a standing kind's box is centred on
 *    the floor with halfY its full height (the lower half buried); a kind with a
 *    `lift` hangs centred there, halfY half its height.
 *    A kind with no entry is not spawned (decals wait for art);
 *  - looks.json: how a run looks per theme (dark fantasy: near-black fog, a dim
 *    ambient, matte shell colours per material slot, the torch light), sent to
 *    the client when a member enters. A theme with no entry looks as the open world.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SpawnTableSchema, type SpawnTable } from "@mmo-engine/scatter";
import { z } from "zod";

const id = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase id (a-z, 0-9, -)");
const range = z.tuple([z.number().int().min(0), z.number().int().min(0)]).refine(([a, b]) => a <= b, "min above max");

export const InstanceRulesSchema = z.strictObject({
  version: z.literal(1),
  /** Party members who may enter together. */
  partySize: z.tuple([z.number().int().min(1), z.number().int().min(1).max(40)]).refine(([a, b]) => a <= b, "min above max"),
  /** The run times out after this. */
  timeLimitMinutes: z.number().positive().max(24 * 60),
  /** A member who leaves (or drops) may come back while the run lasts. */
  reentry: z.boolean(),
  /** An instance nobody is in for this long ends ("abandoned"). */
  emptyTeardownSeconds: z.number().positive().max(3600),
  /** Instances running at once in one region. */
  maxInstances: z.number().int().min(1).max(256),
  /** Creature rules id a spawn point takes when its species has no creature rules. */
  fallbackCreature: id,
  /** Loot rolls from the mob pool per creature killed, and per boss-room creature. */
  lootRollsPerKill: range,
  bossLootRolls: range,
  /** Traps armed per run, in the lowest-id non-entrance rooms. */
  trapsPerRun: z.number().int().min(0).max(64),
  /** Health a sprung trap takes, once, then it is spent. */
  trapHarm: z.number().min(1).max(1000),
  /** How close a member must stand to spring a trap, metres. */
  trapTriggerRadiusM: z.number().positive().max(100),
  /** Chests placed per run, in the lowest-id non-entrance rooms. */
  chestsPerRun: z.number().int().min(0).max(64),
  /** Loot rolls from the chest pool per chest opened. */
  chestLootRolls: range,
  /** How close a member must stand to open a chest, metres. */
  chestOpenRadiusM: z.number().positive().max(100),
  /**
   * "on-report": nothing a run earns is kept until the instance reports its
   * result (a crash before that loses the run). The only mode so far.
   */
  commit: z.literal("on-report"),
  /** Walls (EG12): a body's footprint against props, metres (the character capsule's). */
  wallBodyRadiusM: z.number().min(0).max(5).default(0.4),
  /** A move longer than this in one tick is a teleport (respawn, admin), metres; fly speed is 0.4 m a tick. */
  teleportStepM: z.number().positive().max(100).default(8),
});

const EntranceSchema = z.strictObject({
  name: z.string().min(1).max(60),
  x: z.number(),
  z: z.number(),
  /** How close the party leader must stand, metres. */
  radius: z.number().positive().max(100),
  /** Pool layouts of this dressing rank only (null: any). */
  rank: z.number().int().min(0).nullable(),
  /** Pool layouts of these themes only (empty: any). */
  themes: z.array(z.string()).default([]),
});

const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour, #rrggbb");

/** content/dungeons/looks.json: one entry per dungeon theme, the lights shared by all. */
export const DungeonLooksSchema = z.strictObject({
  version: z.literal(1),
  /** Asset ids that give light (dungeon:torch…). */
  emitters: z.array(z.string().min(1)),
  /** Real point lights at once (the nearest emitters). */
  maxLights: z.number().int().min(0).max(32),
  themes: z.record(
    id,
    z.strictObject({
      label: z.string().min(1),
      background: colour,
      fog: z.strictObject({ color: colour, density: z.number().min(0).max(0.1) }),
      hemisphere: z.strictObject({ sky: colour, ground: colour, intensity: z.number().min(0).max(4) }),
      dir: z.strictObject({ color: colour, intensity: z.number().min(0).max(4) }),
      /** The shell's material slots (floor, wall, ceiling, basin): matte colours. */
      palette: z.record(z.string().min(1), colour),
      torch: z.strictObject({ color: colour, intensity: z.number().min(0).max(2000), range: z.number().positive().max(100), flicker: z.number().min(0).max(1) }),
    }),
  ),
});
export type DungeonLooks = z.infer<typeof DungeonLooksSchema>;

/**
 * content/dungeons/props.local.json (git-ignored, written by `npm run dungeon:art` from the local art catalog): which
 * catalog model stands in for a prop kind. Keys are prop kinds (`coffin`), values catalog model ids; a prop's `AssetRef`
 * hash is the hash of that id, so the client draws the model, not the procedural mesh.
 */
export const PropArtSchema = z.strictObject({
  version: z.literal(1),
  assets: z.record(z.string().regex(/^[a-z][A-Za-z0-9-]*$/), z.string().min(1)),
});

export const EntrancesSchema = z.strictObject({
  version: z.literal(1),
  entrances: z.record(id, EntranceSchema),
});

/** The prop table: a spawn table keyed `dungeon:<kind>` by asset id, and the heights mounted kinds hang at (by kind; metres, the body's centre). */
export const DungeonPropsSchema = SpawnTableSchema.extend({ lift: z.record(z.string(), z.number().min(0).max(30)).default({}) });
export type DungeonProps = z.infer<typeof DungeonPropsSchema> & { archetypes: SpawnTable["archetypes"] };

export type InstanceRules = z.infer<typeof InstanceRulesSchema>;
export type Entrance = z.infer<typeof EntranceSchema>;

const DUNGEON_FILES = ["instances.json", "entrances.json"] as const;

/**
 * Fallback instance rules when no dungeon content exists. Inert while
 * entrances is empty: no entrance means no run can start, so no run ever
 * reads these values. Mirrors the sample pack's instances.json.
 */
export const DEFAULT_INSTANCE_RULES: InstanceRules = {
  version: 1,
  partySize: [1, 5],
  timeLimitMinutes: 45,
  reentry: true,
  emptyTeardownSeconds: 120,
  maxInstances: 8,
  fallbackCreature: "goblin",
  lootRollsPerKill: [0, 1],
  bossLootRolls: [2, 3],
  trapsPerRun: 2,
  trapHarm: 10,
  trapTriggerRadiusM: 2,
  chestsPerRun: 3,
  chestLootRolls: [1, 2],
  chestOpenRadiusM: 3,
  commit: "on-report",
  wallBodyRadiusM: 0.4,
  teleportStepM: 8,
};

/** Valid empty dungeon content: no entrances, so no runs. */
export const EMPTY_DUNGEON_CONTENT: DungeonContent = { rules: DEFAULT_INSTANCE_RULES, entrances: {}, props: { version: 1, archetypes: {}, lift: {} }, looks: null, artAssets: {} };

export interface DungeonContent {
  rules: InstanceRules;
  entrances: Record<string, Entrance>;
  /** What each baked prop kind spawns as (empty: instances spawn no props). */
  props: DungeonProps;
  /** How a run looks per theme (null: runs look as the open world does). */
  looks: DungeonLooks | null;
  /** The local art overlay, kind to catalog model id (already applied to `props`; empty without props.local.json). */
  artAssets: Record<string, string>;
}

export const DEFAULT_DUNGEON_CONTENT = fileURLToPath(new URL("../../../../../content/dungeons", import.meta.url));

export function parseDungeonContent(rules: unknown, entrances: unknown, props?: unknown, looks?: unknown, art?: unknown): DungeonContent {
  const problems: string[] = [];
  const r = InstanceRulesSchema.safeParse(rules);
  if (!r.success) for (const i of r.error.issues) problems.push(`instances.json: ${i.path.join(".") || "(root)"}: ${i.message}`);
  const e = EntrancesSchema.safeParse(entrances);
  if (!e.success) for (const i of e.error.issues) problems.push(`entrances.json: ${i.path.join(".") || "(root)"}: ${i.message}`);
  const p = props === undefined ? { success: true as const, data: { version: 1 as const, archetypes: {}, lift: {} } } : DungeonPropsSchema.safeParse(props);
  if (!p.success) for (const i of p.error.issues) problems.push(`props.json: ${i.path.join(".") || "(root)"}: ${i.message}`);
  const lk = looks === undefined ? { success: true as const, data: null } : DungeonLooksSchema.safeParse(looks);
  if (!lk.success) for (const i of lk.error.issues) problems.push(`looks.json: ${i.path.join(".") || "(root)"}: ${i.message}`);
  const ar = art === undefined ? { success: true as const, data: { version: 1 as const, assets: {} as Record<string, string> } } : PropArtSchema.safeParse(art);
  if (!ar.success) for (const i of ar.error.issues) problems.push(`props.local.json: ${i.path.join(".") || "(root)"}: ${i.message}`);
  if (ar.success && p.success) for (const kind of Object.keys(ar.data.assets)) if (!p.data.archetypes[`dungeon:${kind}`]) problems.push(`props.local.json: assets.${kind}: no such prop kind in props.json`);
  if (!r.success || !e.success || !p.success || !lk.success || !ar.success || problems.length > 0) throw new Error(`dungeon content: ${problems.join("; ")}`);
  const archetypes = { ...p.data.archetypes };
  for (const [kind, asset] of Object.entries(ar.data.assets)) archetypes[`dungeon:${kind}`] = { ...archetypes[`dungeon:${kind}`], asset };
  return { rules: r.data, entrances: e.data.entrances, props: { ...p.data, archetypes }, looks: lk.data, artAssets: ar.data.assets };
}

export function loadDungeonContent(dir: string = DEFAULT_DUNGEON_CONTENT): DungeonContent {
  const missing = DUNGEON_FILES.filter((f) => !existsSync(join(dir, f)));
  if (missing.length === DUNGEON_FILES.length) return EMPTY_DUNGEON_CONTENT;
  if (missing.length > 0) {
    throw new Error(`dungeon content: ${missing.join(", ")}: no such file (dungeon content is both files or none)`);
  }
  const read = (f: string): unknown => JSON.parse(readFileSync(join(dir, f), "utf8"));
  return parseDungeonContent(read("instances.json"), read("entrances.json"), existsSync(join(dir, "props.json")) ? read("props.json") : undefined, existsSync(join(dir, "looks.json")) ? read("looks.json") : undefined, existsSync(join(dir, "props.local.json")) ? read("props.local.json") : undefined);
}
