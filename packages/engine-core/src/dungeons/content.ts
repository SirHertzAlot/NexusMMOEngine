/**
 * Dungeon instance content (roadmap D4): content/dungeons/.
 *
 *  - instances.json: the run's rules. These are the proposed defaults for
 *    DUNGEONS-AND-LOOT.md §10's open questions (party size, time limit,
 *    re-entry, what a crash does), kept as data so they change without code;
 *  - entrances.json: where in the open world a party asks for a dungeon,
 *    and which pool layouts that entrance draws from (rank, themes).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

export const EntrancesSchema = z.strictObject({
  version: z.literal(1),
  entrances: z.record(id, EntranceSchema),
});

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
};

/** Valid empty dungeon content: no entrances, so no runs. */
export const EMPTY_DUNGEON_CONTENT: DungeonContent = { rules: DEFAULT_INSTANCE_RULES, entrances: {} };

export interface DungeonContent {
  rules: InstanceRules;
  entrances: Record<string, Entrance>;
}

export const DEFAULT_DUNGEON_CONTENT = fileURLToPath(new URL("../../../../../content/dungeons", import.meta.url));

export function parseDungeonContent(rules: unknown, entrances: unknown): DungeonContent {
  const problems: string[] = [];
  const r = InstanceRulesSchema.safeParse(rules);
  if (!r.success) for (const i of r.error.issues) problems.push(`instances.json: ${i.path.join(".") || "(root)"}: ${i.message}`);
  const e = EntrancesSchema.safeParse(entrances);
  if (!e.success) for (const i of e.error.issues) problems.push(`entrances.json: ${i.path.join(".") || "(root)"}: ${i.message}`);
  if (!r.success || !e.success) throw new Error(`dungeon content: ${problems.join("; ")}`);
  return { rules: r.data, entrances: e.data.entrances };
}

export function loadDungeonContent(dir: string = DEFAULT_DUNGEON_CONTENT): DungeonContent {
  const missing = DUNGEON_FILES.filter((f) => !existsSync(join(dir, f)));
  if (missing.length === DUNGEON_FILES.length) return { rules: DEFAULT_INSTANCE_RULES, entrances: {} };
  if (missing.length > 0) {
    throw new Error(`dungeon content: ${missing.join(", ")}: no such file (dungeon content is both files or none)`);
  }
  const read = (f: string): unknown => JSON.parse(readFileSync(join(dir, f), "utf8"));
  return parseDungeonContent(read("instances.json"), read("entrances.json"));
}
