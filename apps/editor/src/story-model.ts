/**
 * The Story workspace's model (roadmap EA20), pure TS like
 * inspectors/graph-editor.ts: graphs for the canvas (laid out here, since
 * the server's format has no positions and we don't add any), edits that
 * return new documents, undo, and the dialog tester.
 *
 * The PICG GraphEditor models `.pcg` documents; quests and dialog are
 * different shapes, so this is a small sibling that shares its edge curve
 * (`edgePath`) with the canvas.
 */

export type QuestState = "available" | "active" | "ready" | "done" | "unavailable";

export interface DialogReply {
  text: string;
  next?: string;
  if?: { quest: string; is: QuestState };
  do?: { accept: string } | { complete: string };
}
export interface DialogNodeDoc { text: string; replies: DialogReply[] }
export interface DialogDoc { start: string; nodes: Record<string, DialogNodeDoc> }
export interface QuestDoc {
  name: string;
  giver: string;
  summary: string;
  steps: Array<{ id: string; text: string; objective: Record<string, unknown> }>;
  rewards?: Array<{ base: string; count?: number }>;
  repeatable?: boolean;
  after?: string[];
}
export interface QuestsDoc { version: 1; quests: Record<string, QuestDoc> }

export interface GraphNode {
  id: string;
  kind: "dialog" | "quest" | "step";
  title: string;
  x: number;
  y: number;
  start?: boolean;
  reachable?: boolean;
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  condition?: string;
  effect?: string;
  /** Dialog edges: the reply's index in its node. */
  reply?: number;
}
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }

const COL = 250;
const ROW = 130;

function effectOf(r: DialogReply): string | undefined {
  if (!r.do) return undefined;
  return "accept" in r.do ? `accept ${r.do.accept}` : `complete ${r.do.complete}`;
}

/** A dialog as nodes (start first, then by distance from it) and one edge per reply that leads on. */
export function dialogGraph(d: DialogDoc): Graph {
  const layer = new Map<string, number>();
  const queue: string[] = d.nodes[d.start] ? [d.start] : [];
  if (queue.length) layer.set(d.start, 0);
  for (let i = 0; i < queue.length; i++) {
    for (const r of d.nodes[queue[i]].replies) {
      if (r.next !== undefined && d.nodes[r.next] && !layer.has(r.next)) {
        layer.set(r.next, layer.get(queue[i])! + 1);
        queue.push(r.next);
      }
    }
  }
  const last = Math.max(-1, ...layer.values()) + 1;
  const order = [...queue, ...Object.keys(d.nodes).filter((k) => !layer.has(k))];
  const used = new Map<number, number>();
  const nodes = order.map((id): GraphNode => {
    const l = layer.get(id) ?? last;
    const col = used.get(l) ?? 0;
    used.set(l, col + 1);
    return { id, kind: "dialog", title: id, x: col * COL, y: l * ROW, start: id === d.start, reachable: layer.has(id) };
  });
  const edges: GraphEdge[] = [];
  for (const [id, n] of Object.entries(d.nodes)) {
    n.replies.forEach((r, i) => {
      if (r.next === undefined || !d.nodes[r.next]) return;
      edges.push({ id: `${id}#${i}`, from: id, to: r.next, label: r.text, reply: i, condition: r.if ? `${r.if.quest} is ${r.if.is}` : undefined, effect: effectOf(r) });
    });
  }
  return { nodes, edges };
}

/** Quests as columns: the quest on top, its steps below in order; `after` edges between quests. */
export function questGraph(q: QuestsDoc): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  Object.entries(q.quests).forEach(([qid, quest], col) => {
    nodes.push({ id: qid, kind: "quest", title: quest.name, x: col * COL, y: 0 });
    quest.steps.forEach((s, i) => {
      const id = `${qid}/${s.id}`;
      nodes.push({ id, kind: "step", title: s.text, x: col * COL, y: ROW * 0.7 * (i + 1) });
      edges.push({ id: `${id}#in`, from: i === 0 ? qid : `${qid}/${quest.steps[i - 1].id}`, to: id, label: i === 0 ? "start" : "then" });
    });
    for (const a of quest.after ?? []) edges.push({ id: `${a}>${qid}`, from: a, to: qid, label: "after" });
  });
  return { nodes, edges };
}

// ------------------------------------------------------------------ edits

const copy = <T>(v: T): T => structuredClone(v);

export function addDialogNode(d: DialogDoc, id: string, text = "..."): DialogDoc {
  if (d.nodes[id]) return d;
  const out = copy(d);
  out.nodes[id] = { text, replies: [] };
  return out;
}

export function addReply(d: DialogDoc, node: string, reply: DialogReply): DialogDoc {
  const out = copy(d);
  out.nodes[node].replies.push(reply);
  return out;
}

/** Rename a node; the start and every reply that led to it follow. */
export function renameDialogNode(d: DialogDoc, from: string, to: string): DialogDoc {
  if (from === to || !d.nodes[from] || d.nodes[to]) return d;
  const out = copy(d);
  out.nodes = Object.fromEntries(Object.entries(out.nodes).map(([k, v]) => [k === from ? to : k, v]));
  if (out.start === from) out.start = to;
  for (const n of Object.values(out.nodes)) for (const r of n.replies) if (r.next === from) r.next = to;
  return out;
}

/** Delete a node and the replies that led to it (the start node can't be deleted). */
export function deleteDialogNode(d: DialogDoc, id: string): DialogDoc {
  if (id === d.start || !d.nodes[id]) return d;
  const out = copy(d);
  delete out.nodes[id];
  for (const n of Object.values(out.nodes)) n.replies = n.replies.filter((r) => r.next !== id);
  return out;
}

/** Snapshot undo: every edit pushes the new document. */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  constructor(public value: T) {}
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  push(next: T): void {
    this.past.push(this.value);
    if (this.past.length > 200) this.past.shift();
    this.value = next;
    this.future = [];
  }
  undo(): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(this.value);
    return (this.value = prev);
  }
  redo(): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.value);
    return (this.value = next);
  }
}

// ----------------------------------------------------------------- tester

/** The mock a tester run reads and changes: what the character's quests say, their name, today's board quest. */
export interface MockState {
  name: string;
  /** Quest id (or "board") → state; absent means unavailable. */
  quests: Record<string, QuestState>;
  board: string;
}

export interface TestReply {
  text: string;
  available: boolean;
  /** Why it's hidden (condition not met). */
  why?: string;
  condition?: string;
  effect?: string;
}

/** One position in a walk: the node, its replies against the mock state, and what has happened so far. */
export interface DialogTest {
  readonly node: string;
  readonly text: string;
  readonly replies: TestReply[];
  readonly state: MockState;
  /** Nodes visited before this one. */
  readonly trail: string[];
  /** Effects applied so far, in order. */
  readonly effects: string[];
  readonly ended: boolean;
  /** Pick reply `i` (unavailable or out of range: no change). */
  pick(i: number): DialogTest;
  /** The same position against an edited mock state. */
  withState(state: MockState): DialogTest;
}

function build(d: DialogDoc, node: string, state: MockState, trail: string[], effects: string[], ended: boolean): DialogTest {
  const n = d.nodes[node];
  const replies: TestReply[] = (n?.replies ?? []).map((r) => {
    const have = r.if ? (state.quests[r.if.quest] ?? "unavailable") : undefined;
    const ok = !r.if || have === r.if.is;
    return {
      text: r.text,
      available: ok,
      why: ok ? undefined : `${r.if!.quest} is ${have}, needs ${r.if!.is}`,
      condition: r.if ? `${r.if.quest} is ${r.if.is}` : undefined,
      effect: effectOf(r),
    };
  });
  return {
    node, state, trail, effects, ended, replies,
    text: (n?.text ?? "").replaceAll("{name}", state.name).replaceAll("{board}", state.board || "nothing today"),
    pick(i) {
      const r = n?.replies[i];
      if (ended || !r || !replies[i].available) return this;
      const quests = { ...state.quests };
      const fx = [...effects];
      if (r.do && "accept" in r.do) {
        quests[r.do.accept] = "active";
        fx.push(`accepted ${r.do.accept}`);
      } else if (r.do) {
        quests[r.do.complete] = "done";
        fx.push(`completed ${r.do.complete}`);
      }
      const next = { ...state, quests };
      return r.next !== undefined && d.nodes[r.next] ? build(d, r.next, next, [...trail, node], fx, false) : build(d, node, next, [...trail, node], fx, true);
    },
    withState: (s) => build(d, node, s, trail, effects, ended),
  };
}

/** Start walking a dialog from its start node. */
export function startTest(d: DialogDoc, state: MockState): DialogTest {
  return build(d, d.start, state, [], [], false);
}
