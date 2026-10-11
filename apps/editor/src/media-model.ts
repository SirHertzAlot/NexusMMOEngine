/**
 * Pure edit helpers behind the Animation workspace (EA21): the combat
 * timeline's markers, the locomotion graph's rows and layout, and the
 * checks of the graph and the moves against the rig's clips. No React.
 */
import type { AnimationManifest, Gait, LocomotionGraph } from "@mmo-engine/art/browser";
import type { CombatMove } from "@mmo-engine/protocol";

/** The server's tick rate: the timeline counts frames at this rate. */
export const TICK_HZ = 30;
export const toFrame = (sec: number): number => Math.round(sec * TICK_HZ);
export const toSec = (frame: number): number => Math.round((frame / TICK_HZ) * 10000) / 10000;

export const MARKERS = ["hitAt", "branchAt", "chain.from", "chain.to", "advance.from", "advance.to", "iframes.from", "iframes.to"] as const;
export type Marker = (typeof MARKERS)[number];
export type WindowName = "chain" | "advance" | "iframes";

const snap = (sec: number, duration: number): number => Math.min(duration, Math.max(0, toSec(toFrame(sec))));

export function markerValue(m: CombatMove, marker: Marker): number | undefined {
  if (marker === "hitAt" || marker === "branchAt") return m[marker];
  const [w, end] = marker.split(".") as [WindowName, "from" | "to"];
  return m[w]?.[end];
}

/** Move a marker to `sec` (snapped to a frame, kept inside the move, a window's from kept before its to). Returns a new move. */
export function setMarker(m: CombatMove, marker: Marker, sec: number): CombatMove {
  const v = snap(sec, m.duration);
  if (marker === "hitAt" || marker === "branchAt") return { ...m, [marker]: v };
  const [w, end] = marker.split(".") as [WindowName, "from" | "to"];
  const win = m[w];
  if (!win) return m;
  const next = { ...win, [end]: end === "from" ? Math.min(v, win.to) : Math.max(v, win.from) };
  return { ...m, [w]: next };
}

/** Change the move's length; markers past the new end are pulled in. */
export function setDuration(m: CombatMove, duration: number): CombatMove {
  const d = Math.max(0.1, toSec(toFrame(duration)));
  const clampTo = (x: number): number => Math.min(x, d);
  const out: CombatMove = { ...m, duration: d };
  if (out.hitAt !== undefined) out.hitAt = clampTo(out.hitAt);
  if (out.branchAt !== undefined) out.branchAt = clampTo(out.branchAt);
  for (const w of ["chain", "advance", "iframes"] as const) {
    const win = out[w];
    if (win) (out as unknown as Record<string, unknown>)[w] = { ...win, from: clampTo(win.from), to: clampTo(win.to) };
  }
  return out;
}

/** Add a window with a sensible default span, or remove it. */
export function toggleWindow(m: CombatMove, w: WindowName, moves: readonly CombatMove[]): CombatMove {
  if (m[w]) {
    const { [w]: _gone, ...rest } = m;
    return rest as CombatMove;
  }
  const span = { from: toSec(toFrame(m.duration * 0.2)), to: toSec(toFrame(m.duration * 0.8)) };
  if (w === "chain") return { ...m, chain: { next: moves.find((x) => x.id !== m.id && x.kind === "attack")?.id ?? m.id, ...span } };
  if (w === "advance") return { ...m, advance: { distance: 1, ...span } };
  return { ...m, iframes: span };
}

/** Optional hit frame: add one at the middle, or take it away. */
export function toggleHit(m: CombatMove): CombatMove {
  if (m.hitAt !== undefined) {
    const { hitAt: _gone, ...rest } = m;
    return rest as CombatMove;
  }
  return { ...m, hitAt: snap(m.duration / 2, m.duration) };
}

// ---------------------------------------------------------------- locomotion

export type Medium = "ground" | "swim" | "fly";
export const MEDIUMS: readonly Medium[] = ["ground", "swim", "fly"];

export function addGait(g: LocomotionGraph, medium: Medium, clip: string): LocomotionGraph {
  const last = g[medium].at(-1);
  const gait: Gait = { clip, speed: Math.round(((last?.speed ?? 1) + 1.5) * 10) / 10, from: Math.round(((last?.from ?? 0) + 1) * 10) / 10 };
  return { ...g, [medium]: [...g[medium], gait] };
}

export function setGait(g: LocomotionGraph, medium: Medium, i: number, patch: Partial<Gait>): LocomotionGraph {
  const list = g[medium].map((x, k) => (k === i ? { ...x, ...patch } : x));
  for (const x of list) if (x.fade === undefined) delete x.fade;
  return { ...g, [medium]: list };
}

export function removeGait(g: LocomotionGraph, medium: Medium, i: number): LocomotionGraph {
  return { ...g, [medium]: g[medium].filter((_, k) => k !== i) };
}

export interface StateNode {
  id: string;
  label: string;
  detail: string;
  medium: Medium | "air";
  x: number;
  y: number;
  clip: string;
  /** The gait's index in its medium; -1 for the idle and air states. */
  gait: number;
}
export interface StateEdge {
  from: string;
  to: string;
  label: string;
  /** Crossfade into the target, seconds. */
  fade: number;
}

/** The graph as nodes and edges for drawing: a row per medium, idle then the gaits by speed; the air state below. */
export function stateGraph(g: LocomotionGraph): { nodes: StateNode[]; edges: StateEdge[] } {
  const nodes: StateNode[] = [];
  const edges: StateEdge[] = [];
  MEDIUMS.forEach((medium, row) => {
    const y = 20 + row * 80;
    nodes.push({ id: `${medium}:idle`, label: `${medium} idle`, detail: g.idle[medium], medium, x: 20, y, clip: g.idle[medium], gait: -1 });
    g[medium].forEach((gait, i) => {
      nodes.push({ id: `${medium}:${i}`, label: gait.clip, detail: `from ${gait.from} m/s · ${gait.speed} m/s`, medium, x: 20 + (i + 1) * 170, y, clip: gait.clip, gait: i });
      const prev = i === 0 ? `${medium}:idle` : `${medium}:${i - 1}`;
      edges.push({ from: prev, to: `${medium}:${i}`, label: `speed >= ${gait.from}`, fade: gait.fade ?? g.fade });
      edges.push({ from: `${medium}:${i}`, to: prev, label: `speed < ${gait.from}`, fade: (i === 0 ? undefined : g[medium][i - 1].fade) ?? g.fade });
    });
  });
  nodes.push({ id: "air", label: "air", detail: g.idle.air, medium: "air", x: 20 + 170, y: 20 + MEDIUMS.length * 80, clip: g.idle.air, gait: -1 });
  edges.push({ from: "ground:idle", to: "air", label: `|vy| > ${g.airborneVy} for ${g.airSeconds} s`, fade: g.fade });
  edges.push({ from: "air", to: "ground:idle", label: "grounded", fade: g.fade });
  return { nodes, edges };
}

/** The state id a pick lands in (to highlight it). */
export function stateOf(pick: { medium: string; gait: Gait | null }, g: LocomotionGraph): string {
  if (pick.medium === "air") return "air";
  const list = g[pick.medium as Medium];
  const i = pick.gait ? list.indexOf(pick.gait) : -1;
  return i < 0 ? `${pick.medium}:idle` : `${pick.medium}:${i}`;
}

// ---------------------------------------------------------------- checks against the rig

export interface ClipUse {
  clip: string;
  where: string[];
}

/** Which locomotion states and combat moves play each clip. */
export function clipUsage(g: LocomotionGraph, moves: readonly CombatMove[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (clip: string, where: string): void => void out.set(clip, [...(out.get(clip) ?? []), where]);
  for (const medium of MEDIUMS) {
    add(g.idle[medium], `${medium} idle`);
    g[medium].forEach((x) => add(x.clip, `${medium} ${x.from}+ m/s`));
  }
  add(g.idle.air, "air");
  for (const m of moves) add(m.clip, `move: ${m.name}`);
  return out;
}

/** The graph and the moves against the rig's clips: a missing clip, a move longer or shorter than its clip, a reference take. */
export function checkAgainstRig(manifest: AnimationManifest, g: LocomotionGraph, moves: readonly CombatMove[]): string[] {
  const clips = new Map(manifest.clips.map((c) => [c.name, c]));
  const out: string[] = [];
  const has = (name: string): boolean => clips.has(name);
  for (const [clip, where] of clipUsage(g, moves)) {
    if (!has(clip) && !has(`${clip}.F`)) out.push(`${clip} (${where.join(", ")}) is not in the rig's library`);
  }
  for (const m of moves) {
    const c = clips.get(m.clip);
    if (!c) continue;
    if (Math.abs(c.duration - m.duration) > 0.02) out.push(`${m.name}: lasts ${m.duration} s, its clip ${m.clip} lasts ${c.duration.toFixed(3)} s`);
    if (manifest.sources.find((s) => s.id === c.source)?.reference) out.push(`${m.name}: ${m.clip} is a reference take, not loaded by the game`);
  }
  return out;
}
