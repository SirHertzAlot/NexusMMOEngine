/**
 * Quest and dialog validation for the Story workspace (roadmap EA20).
 *
 * The documents are the four files the server already loads from
 * content/quests (steps, quests, npcs, dialogs). Nothing here defines a
 * format: errors come from the server's own zod schemas and cross-file
 * check (`QuestServer`, loaded from engine-core's build by story-host.ts),
 * so a set that passes can never stop the server booting. On top of that:
 *
 *  - references into the rules: item bases (rewards, collect) and species
 *    (kill) must exist (error);
 *  - quest prerequisite (`after`) cycles (error);
 *  - dialog loops with no way out (error); loops with a way out are normal
 *    hubs and only listed by `dialogCycles`;
 *  - quests no dialog accepts or completes (warning).
 *
 * Only errors block a save. Pure: no I/O.
 */

export const STORY_FILES = ["quests", "dialogs", "npcs", "steps"] as const;
export type StoryFile = (typeof STORY_FILES)[number];
export type StoryFiles = Record<StoryFile, unknown>;

export interface StoryIssue {
  file: StoryFile;
  /** Dotted path in the file as the server reports it (`quests.goblin-trouble.steps.2.text`); "" for the file. */
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface StoryRefs {
  /** Item base ids (rules items.bases). */
  items: ReadonlySet<string>;
  /** Creature kinds (rules creatures). */
  species: ReadonlySet<string>;
}

/** The server's quest loader as the editor needs it (engine-core quests/content.ts). */
export interface QuestServer {
  schemas: Record<StoryFile, { safeParse(x: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }>;
  check(content: unknown): string[];
}

interface Reply { text: string; next?: string; if?: { quest: string }; do?: { accept?: string; complete?: string } }
interface Dialog { start: string; nodes: Record<string, { text: string; replies: Reply[] }> }
interface Quest { giver: string; steps: Array<{ id: string; objective: { type: string; kind?: string; base?: string } }>; rewards: Array<{ base: string }>; after: string[] }
interface Parsed {
  steps: { stages: string[]; steps: Record<string, { objective: { type: string; kind?: string; base?: string } }>; templates: Record<string, unknown> };
  quests: { quests: Record<string, Quest> };
  npcs: { npcs: Record<string, unknown> };
  dialogs: { dialogs: Record<string, Dialog> };
}

const ROOT_FILE: Record<string, StoryFile> = { stages: "steps", steps: "steps", templates: "steps", quests: "quests", npcs: "npcs", dialogs: "dialogs" };

/** A strongly connected group of dialog nodes (a loop); `exits` is false when no reply inside leaves it or ends the talk. */
export interface DialogCycle { nodes: string[]; exits: boolean }

/** Every loop in a dialog's reachable nodes (Tarjan's strongly connected components). */
export function dialogCycles(d: Dialog): DialogCycle[] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: DialogCycle[] = [];
  let n = 0;
  const succ = (id: string): string[] => (d.nodes[id]?.replies ?? []).flatMap((r) => (r.next !== undefined && d.nodes[r.next] ? [r.next] : []));
  const visit = (v: string): void => {
    index.set(v, n);
    low.set(v, n++);
    stack.push(v);
    on.add(v);
    for (const w of succ(v)) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) !== index.get(v)) return;
    const comp: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      on.delete(w);
      comp.push(w);
    } while (w !== v);
    if (comp.length === 1 && !succ(v).includes(v)) return;
    const set = new Set(comp);
    const exits = comp.some((c) => {
      const replies = d.nodes[c].replies;
      return replies.length === 0 || replies.some((r) => r.next === undefined || !set.has(r.next));
    });
    out.push({ nodes: comp.reverse(), exits });
  };
  if (d.nodes[d.start]) visit(d.start);
  return out;
}

/** Cycles in the `after` graph, each as the quest ids on it. */
function questCycles(quests: Record<string, Quest>): string[][] {
  const seen = new Set<string>();
  const found: string[][] = [];
  const walk = (id: string, path: string[]): void => {
    const at = path.indexOf(id);
    if (at >= 0) {
      found.push(path.slice(at));
      return;
    }
    if (seen.has(id) || !quests[id]) return;
    seen.add(id);
    for (const a of quests[id].after) walk(a, [...path, id]);
  };
  for (const id of Object.keys(quests)) walk(id, []);
  return found;
}

export function validateStory(files: StoryFiles, refs: StoryRefs, server: QuestServer): StoryIssue[] {
  const issues: StoryIssue[] = [];
  const add = (file: StoryFile, path: string, message: string, severity: StoryIssue["severity"] = "error"): void => {
    issues.push({ file, path, message, severity });
  };
  const data: Partial<Record<StoryFile, unknown>> = {};
  for (const f of STORY_FILES) {
    const r = server.schemas[f].safeParse(files[f]);
    if (r.success) data[f] = r.data;
    else for (const i of r.error.issues) add(f, i.path.map(String).join("."), i.message);
  }
  if (issues.length > 0) return issues;
  const p = data as unknown as Parsed;

  // The server's cross-file checks: "<path>: <message>" strings.
  const joined = {
    stages: p.steps.stages, steps: p.steps.steps, templates: p.steps.templates,
    quests: p.quests.quests, npcs: p.npcs.npcs, dialogs: p.dialogs.dialogs,
  };
  for (const line of server.check(joined)) {
    const at = line.indexOf(": ");
    const path = at < 0 ? "" : line.slice(0, at).replace(/^(\w+)\.json$/, "");
    add(ROOT_FILE[path.split(".")[0]] ?? "quests", path, at < 0 ? line : line.slice(at + 2));
  }

  const kind = (file: StoryFile, path: string, v: string | undefined, set: ReadonlySet<string>, what: string): void => {
    if (v !== undefined && !v.startsWith("$") && !set.has(v)) add(file, path, `unknown ${what} "${v}"`);
  };
  for (const [qid, q] of Object.entries(p.quests.quests)) {
    q.steps.forEach((s, i) => {
      const o = s.objective;
      if (o.type === "kill") kind("quests", `quests.${qid}.steps.${i}.objective.kind`, o.kind, refs.species, "species");
      if (o.type === "collect") kind("quests", `quests.${qid}.steps.${i}.objective.base`, o.base, refs.items, "item base");
    });
    q.rewards.forEach((r, i) => kind("quests", `quests.${qid}.rewards.${i}.base`, r.base, refs.items, "item base"));
  }
  for (const [sid, s] of Object.entries(p.steps.steps)) {
    const o = s.objective;
    if (o.type === "kill") kind("steps", `steps.${sid}.objective.kind`, o.kind, refs.species, "species");
    if (o.type === "collect") kind("steps", `steps.${sid}.objective.base`, o.base, refs.items, "item base");
  }

  for (const cyc of questCycles(p.quests.quests)) add("quests", `quests.${cyc[0]}.after`, `prerequisite cycle: ${[...cyc, cyc[0]].join(" -> ")}`);

  const accepted = new Set<string>();
  const completed = new Set<string>();
  for (const [did, d] of Object.entries(p.dialogs.dialogs)) {
    for (const c of dialogCycles(d)) if (!c.exits) add("dialogs", `dialogs.${did}.nodes.${c.nodes[0]}`, `dialog loop with no way out: ${c.nodes.join(" -> ")}`);
    for (const n of Object.values(d.nodes)) {
      for (const r of n.replies) {
        if (r.do?.accept) accepted.add(r.do.accept);
        if (r.do?.complete) completed.add(r.do.complete);
      }
    }
  }
  for (const qid of Object.keys(p.quests.quests)) {
    if (!accepted.has(qid)) add("quests", `quests.${qid}`, "no dialog reply accepts this quest, so no one can take it", "warning");
    if (!completed.has(qid)) add("quests", `quests.${qid}`, "no dialog reply completes this quest, so it can't be handed in", "warning");
  }
  return issues;
}
