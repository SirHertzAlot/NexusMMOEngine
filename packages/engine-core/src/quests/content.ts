/**
 * Quest and dialog content (roadmap P1): the data the progression graphs are
 * built from, read from content/quests/.
 *
 *  - steps.json: the stages a quest runs through (hook → travel → obstacle →
 *    twist → confrontation → reward) and the step types that can fill each,
 *    with their objective, text, and the tags they give and need ("a twist
 *    needs an earlier ally"); plus quest templates (which stages, which
 *    rewards) that WFC collapses into concrete quests (generate.ts);
 *  - quests.json: authored quests, written step by step;
 *  - npcs.json: the characters who give and take quests: where they stand,
 *    their dialog, the generated quests their board offers, and the places
 *    nearby a generated quest can send you;
 *  - dialogs.json: dialog graphs: nodes of lines and replies, each reply
 *    with an optional condition (`if`) and action (`do`).
 *
 * `loadQuestContent` parses every file (zod, strict) and checks the whole
 * set: unknown stages, steps, quests, npcs, dialogs and dialog nodes, tags
 * no earlier stage can give, unreachable dialog nodes. A bad set throws one
 * error naming every problem, so a server never starts on broken quests.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const id = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase id (a-z, 0-9, -)");
const range = z.tuple([z.number().int().min(1), z.number().int().min(1)]).refine(([a, b]) => a <= b, "min above max");

/**
 * An objective as content writes it. `$name` strings are bindings filled
 * when a quest is generated: `$giver` (the npc offering it), `$species`
 * (a creature kind living near the giver), `$place` (one of the giver's
 * places), `$item` (an item base). Counts may be ranges, drawn per quest.
 */
const ObjectiveSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("talk"), npc: z.string() }),
  z.strictObject({ type: z.literal("kill"), kind: z.string(), count: z.union([z.number().int().min(1), range]) }),
  z.strictObject({ type: z.literal("reach"), place: z.string() }),
  z.strictObject({ type: z.literal("collect"), base: z.string(), count: z.union([z.number().int().min(1), range]) }),
]);

const RewardSchema = z.strictObject({
  /** An item base (sword, dagger, …) or `$item`; the server picks a definition of it. */
  base: z.string(),
  count: z.number().int().min(1).max(10).default(1),
  /** Gold paid alongside (or instead of) the item; absent: none. */
  gold: z.number().int().positive().max(999999).optional(),
});

const StepTypeSchema = z.strictObject({
  stage: id,
  /** Shown in the quest log; `{giver} {species} {Species} {place} {count} {item}` are filled in. */
  text: z.string().min(1).max(300),
  objective: ObjectiveSchema,
  weight: z.number().positive().default(1),
  /** Tags this step gives the quest (an ally met, an item found). */
  gives: z.array(id).default([]),
  /** Tags an earlier step must have given. */
  needs: z.array(id).default([]),
  /** Tags that may not appear anywhere else in the same quest. */
  excludes: z.array(id).default([]),
});

const TemplateSchema = z.strictObject({
  /** Quest name, templated like step text. */
  name: z.string().min(1).max(80),
  /** The stages, in order: one step each. */
  stages: z.array(id).min(1).max(12),
  rewards: z.array(RewardSchema).max(5).default([]),
});

export const StepsFileSchema = z.strictObject({
  version: z.literal(1),
  stages: z.array(id).min(1),
  steps: z.record(id, StepTypeSchema),
  templates: z.record(id, TemplateSchema),
});

const AuthoredStepSchema = z.strictObject({
  id: id,
  text: z.string().min(1).max(300),
  objective: ObjectiveSchema,
});

const AuthoredQuestSchema = z.strictObject({
  name: z.string().min(1).max(80),
  giver: id,
  /** Shown when offered. */
  summary: z.string().min(1).max(500),
  steps: z.array(AuthoredStepSchema).min(1).max(20),
  rewards: z.array(RewardSchema).max(5).default([]),
  /** Done quests can be taken again (default: once per character). */
  repeatable: z.boolean().default(false),
  /** Quests that must be done first. */
  after: z.array(id).default([]),
});

export const QuestsFileSchema = z.strictObject({
  version: z.literal(1),
  quests: z.record(id, AuthoredQuestSchema),
});

const PlaceSchema = z.strictObject({ name: z.string().min(1).max(60), x: z.number(), z: z.number(), radius: z.number().positive().max(200).default(12) });

const NpcSchema = z.strictObject({
  name: z.string().min(1).max(40),
  x: z.number(),
  z: z.number(),
  /** How close a character must stand to talk, metres. */
  talkRange: z.number().positive().max(50).default(6),
  dialog: id,
  /** The templates this npc's board draws generated quests from. */
  board: z.array(id).default([]),
  places: z.array(PlaceSchema).default([]),
});

export const NpcsFileSchema = z.strictObject({
  version: z.literal(1),
  npcs: z.record(id, NpcSchema),
});

/** A reply's condition: a quest's state for this character. `board` is the npc's current generated quest. */
const ConditionSchema = z.strictObject({
  quest: z.union([id, z.literal("board")]),
  is: z.enum(["available", "active", "ready", "done", "unavailable"]),
});

/** A reply's action: take a quest (an authored id or the board's), hand one in, or leave. */
const ActionSchema = z.union([
  z.strictObject({ accept: z.union([id, z.literal("board")]) }),
  z.strictObject({ complete: z.union([id, z.literal("board")]) }),
]);

const ReplySchema = z.strictObject({
  text: z.string().min(1).max(200),
  /** The node it leads to (none: the dialog ends). */
  next: id.optional(),
  if: ConditionSchema.optional(),
  do: ActionSchema.optional(),
});

const NodeSchema = z.strictObject({
  /** The npc's line; `{name}` (the character's name) and `{board}` (the board quest's name) are filled in. */
  text: z.string().min(1).max(600),
  replies: z.array(ReplySchema).max(8).default([]),
});

const DialogSchema = z.strictObject({
  start: id,
  nodes: z.record(id, NodeSchema),
});

export const DialogsFileSchema = z.strictObject({
  version: z.literal(1),
  dialogs: z.record(id, DialogSchema),
});

export type Objective = z.infer<typeof ObjectiveSchema>;
export type RewardSpec = z.infer<typeof RewardSchema>;
export type StepType = z.infer<typeof StepTypeSchema>;
export type QuestTemplate = z.infer<typeof TemplateSchema>;
export type AuthoredQuest = z.infer<typeof AuthoredQuestSchema>;
export type NpcDef = z.infer<typeof NpcSchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type DialogDef = z.infer<typeof DialogSchema>;
export type DialogNode = z.infer<typeof NodeSchema>;
export type DialogReply = z.infer<typeof ReplySchema>;
export type DialogCondition = z.infer<typeof ConditionSchema>;
export type DialogAction = z.infer<typeof ActionSchema>;

export interface QuestContent {
  stages: string[];
  steps: Record<string, StepType>;
  templates: Record<string, QuestTemplate>;
  quests: Record<string, AuthoredQuest>;
  npcs: Record<string, NpcDef>;
  dialogs: Record<string, DialogDef>;
}

export const DEFAULT_QUEST_DIR = fileURLToPath(new URL("../../../../../content/quests", import.meta.url));

/** Valid empty quest content: no stages, steps, templates, quests, npcs or dialogs. */
export const EMPTY_QUEST_CONTENT: QuestContent = {
  stages: [],
  steps: {},
  templates: {},
  quests: {},
  npcs: {},
  dialogs: {},
};

/** True when a quest content holds nothing authored. */
export function isQuestContentEmpty(c: QuestContent): boolean {
  return (
    c.stages.length === 0 &&
    Object.keys(c.steps).length === 0 &&
    Object.keys(c.templates).length === 0 &&
    Object.keys(c.quests).length === 0 &&
    Object.keys(c.npcs).length === 0 &&
    Object.keys(c.dialogs).length === 0
  );
}

export class QuestContentError extends Error {
  constructor(readonly problems: string[]) {
    super(`quest content: ${problems.join("; ")}`);
    this.name = "QuestContentError";
  }
}

function parse<T>(schema: z.ZodType<T>, json: unknown, file: string, problems: string[]): T | null {
  const r = schema.safeParse(json);
  if (r.success) return r.data;
  for (const i of r.error.issues) problems.push(`${file}: ${i.path.join(".") || "(root)"}: ${i.message}`);
  return null;
}

/** Parse the four files' JSON and check them together. Throws QuestContentError naming every problem. */
export function parseQuestContent(files: { steps: unknown; quests: unknown; npcs: unknown; dialogs: unknown }): QuestContent {
  const problems: string[] = [];
  const steps = parse(StepsFileSchema, files.steps, "steps.json", problems);
  const quests = parse(QuestsFileSchema, files.quests, "quests.json", problems);
  const npcs = parse(NpcsFileSchema, files.npcs, "npcs.json", problems);
  const dialogs = parse(DialogsFileSchema, files.dialogs, "dialogs.json", problems);
  if (!steps || !quests || !npcs || !dialogs) throw new QuestContentError(problems);
  const content: QuestContent = {
    stages: steps.stages,
    steps: steps.steps,
    templates: steps.templates,
    quests: quests.quests,
    npcs: npcs.npcs,
    dialogs: dialogs.dialogs,
  };
  problems.push(...checkQuestContent(content));
  if (problems.length > 0) throw new QuestContentError(problems);
  return content;
}

const QUEST_FILES = ["steps.json", "quests.json", "npcs.json", "dialogs.json"] as const;

/**
 * Load the quest content. A missing dir (or a dir with none of the files) is
 * a valid empty quest set — the engine boots game-less. A half-present dir
 * is an authoring error and fails loud naming the missing files; a present
 * but invalid file still fails loud.
 */
export function loadQuestContent(dir: string = DEFAULT_QUEST_DIR): QuestContent {
  const missing = QUEST_FILES.filter((f) => !existsSync(join(dir, f)));
  if (missing.length === QUEST_FILES.length) return structuredClone(EMPTY_QUEST_CONTENT);
  if (missing.length > 0) {
    throw new QuestContentError(missing.map((f) => `${f}: no such file (quest content is all four files or none)`));
  }
  const read = (f: string): unknown => JSON.parse(readFileSync(join(dir, f), "utf8"));
  return parseQuestContent({ steps: read("steps.json"), quests: read("quests.json"), npcs: read("npcs.json"), dialogs: read("dialogs.json") });
}

const BINDINGS = new Set(["$giver", "$species", "$place", "$item"]);

/** Cross-file problems (empty: fine). */
export function checkQuestContent(c: QuestContent): string[] {
  const problems: string[] = [];
  const stageIndex = new Map(c.stages.map((s, i) => [s, i]));
  if (stageIndex.size !== c.stages.length) problems.push("steps.json: a stage is listed twice");

  // Step types: a known stage; tags they need given by some step of an earlier stage.
  for (const [sid, st] of Object.entries(c.steps)) {
    const at = stageIndex.get(st.stage);
    if (at === undefined) {
      problems.push(`steps.${sid}: unknown stage "${st.stage}"`);
      continue;
    }
    for (const tag of st.needs) {
      const givers = Object.values(c.steps).filter((o) => o.gives.includes(tag) && (stageIndex.get(o.stage) ?? Infinity) < at);
      if (givers.length === 0) problems.push(`steps.${sid}: needs "${tag}", which no step of an earlier stage gives`);
    }
    checkObjective(st.objective, `steps.${sid}`, true, c, problems);
  }

  // Templates: known stages in order, each with at least one step type.
  for (const [tid, t] of Object.entries(c.templates)) {
    let last = -1;
    for (const s of t.stages) {
      const at = stageIndex.get(s);
      if (at === undefined) {
        problems.push(`templates.${tid}: unknown stage "${s}"`);
        continue;
      }
      if (at <= last) problems.push(`templates.${tid}: stage "${s}" out of order`);
      last = at;
      if (!Object.values(c.steps).some((st) => st.stage === s)) problems.push(`templates.${tid}: no step type fills stage "${s}"`);
    }
  }

  // Authored quests: a known giver, unique step ids, known prerequisites, concrete objectives.
  for (const [qid, q] of Object.entries(c.quests)) {
    if (!c.npcs[q.giver]) problems.push(`quests.${qid}: unknown giver "${q.giver}"`);
    const seen = new Set<string>();
    for (const s of q.steps) {
      if (seen.has(s.id)) problems.push(`quests.${qid}: step "${s.id}" twice`);
      seen.add(s.id);
      checkObjective(s.objective, `quests.${qid}.${s.id}`, false, c, problems, q.giver);
    }
    for (const a of q.after) if (!c.quests[a]) problems.push(`quests.${qid}: after unknown quest "${a}"`);
    for (const r of q.rewards) if (r.base.startsWith("$")) problems.push(`quests.${qid}: reward "${r.base}" is a binding (authored quests name the base)`);
  }

  // Npcs: a known dialog and board templates.
  for (const [nid, n] of Object.entries(c.npcs)) {
    if (!c.dialogs[n.dialog]) problems.push(`npcs.${nid}: unknown dialog "${n.dialog}"`);
    for (const t of n.board) if (!c.templates[t]) problems.push(`npcs.${nid}: board template "${t}" unknown`);
  }

  // Dialogs: start and next nodes exist, every node reachable, quests named exist.
  for (const [did, d] of Object.entries(c.dialogs)) {
    if (!d.nodes[d.start]) problems.push(`dialogs.${did}: start node "${d.start}" missing`);
    const reach = new Set<string>();
    const stack = d.nodes[d.start] ? [d.start] : [];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (reach.has(n)) continue;
      reach.add(n);
      for (const r of d.nodes[n].replies) {
        if (r.next !== undefined && d.nodes[r.next]) stack.push(r.next);
      }
    }
    for (const [nid, node] of Object.entries(d.nodes)) {
      if (!reach.has(nid)) problems.push(`dialogs.${did}: node "${nid}" can't be reached`);
      for (const r of node.replies) {
        if (r.next !== undefined && !d.nodes[r.next]) problems.push(`dialogs.${did}.${nid}: reply "${r.text}" leads to missing node "${r.next}"`);
        const named = [r.if?.quest, r.do && "accept" in r.do ? r.do.accept : r.do?.complete].filter((q): q is string => q !== undefined && q !== "board");
        for (const q of named) if (!c.quests[q]) problems.push(`dialogs.${did}.${nid}: unknown quest "${q}"`);
      }
    }
  }
  return problems;
}

function checkObjective(o: Objective, where: string, bindingsAllowed: boolean, c: QuestContent, problems: string[], giver?: string): void {
  const values = o.type === "talk" ? [o.npc] : o.type === "kill" ? [o.kind] : o.type === "reach" ? [o.place] : [o.base];
  for (const v of values) {
    if (v.startsWith("$")) {
      if (!bindingsAllowed) problems.push(`${where}: "${v}" is a binding (authored quests name things)`);
      else if (!BINDINGS.has(v)) problems.push(`${where}: unknown binding "${v}"`);
    }
  }
  if (o.type === "talk" && !o.npc.startsWith("$") && !c.npcs[o.npc]) problems.push(`${where}: talk to unknown npc "${o.npc}"`);
  if (o.type === "reach" && !o.place.startsWith("$")) {
    const known = giver ? c.npcs[giver]?.places.some((p) => p.name === o.place) : Object.values(c.npcs).some((n) => n.places.some((p) => p.name === o.place));
    if (!known) problems.push(`${where}: reach unknown place "${o.place}"${giver ? ` (not one of ${giver}'s places)` : ""}`);
  }
}
