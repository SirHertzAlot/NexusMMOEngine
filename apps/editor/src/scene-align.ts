/**
 * Aligning and distributing selected nodes (roadmap EB2).
 *
 * The arithmetic of "line these up" and "space these evenly", kept away
 * from React and from the document so it can be tested as arithmetic. Both
 * work on each node's own transform position — the numbers the Details pane
 * shows and the gizmo writes — so a selection spread across different
 * parents aligns by those numbers rather than by where the parents put
 * them. (Scenes nest shallowly in practice, and a rule you can read off the
 * inspector beats one you cannot.)
 *
 * Both return only the nodes whose position actually changes, so an
 * undo step is never recorded for a no-op.
 */

export type Axis = 0 | 1 | 2;
export const AXIS_NAME: Readonly<Record<Axis, string>> = { 0: "x", 1: "y", 2: "z" };

/** Where a row lines up: the lowest value, the middle of the spread, or the highest. */
export type AlignMode = "min" | "centre" | "max";

export type Vec3 = [number, number, number];
export type Positions = Readonly<Record<string, Vec3>>;

const changed = (before: Positions, after: Record<string, Vec3>): Record<string, Vec3> => {
  const out: Record<string, Vec3> = {};
  for (const [id, p] of Object.entries(after)) {
    const was = before[id];
    if (!was || was[0] !== p[0] || was[1] !== p[1] || was[2] !== p[2]) out[id] = p;
  }
  return out;
};

const values = (positions: Positions, axis: Axis): number[] => Object.values(positions).map((p) => p[axis]);

/** Line every node up on `axis`. Fewer than two nodes changes nothing. */
export function alignPositions(positions: Positions, axis: Axis, mode: AlignMode): Record<string, Vec3> {
  const ids = Object.keys(positions);
  if (ids.length < 2) return {};
  const all = values(positions, axis);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const target = mode === "min" ? lo : mode === "max" ? hi : (lo + hi) / 2;
  const after: Record<string, Vec3> = {};
  for (const id of ids) {
    const p = positions[id];
    after[id] = [p[0], p[1], p[2]];
    after[id][axis] = target;
  }
  return changed(positions, after);
}

/**
 * Even gaps along `axis`, between the two outermost nodes, which stay put.
 * Fewer than three nodes changes nothing: two are already evenly spaced.
 */
export function distributePositions(positions: Positions, axis: Axis): Record<string, Vec3> {
  const ids = Object.keys(positions);
  if (ids.length < 3) return {};
  const order = [...ids].sort((a, b) => positions[a][axis] - positions[b][axis]);
  const first = positions[order[0]][axis];
  const last = positions[order[order.length - 1]][axis];
  const step = (last - first) / (order.length - 1);
  const after: Record<string, Vec3> = {};
  order.forEach((id, i) => {
    const p = positions[id];
    after[id] = [p[0], p[1], p[2]];
    after[id][axis] = first + step * i;
  });
  return changed(positions, after);
}

/** Move every node by the same amount (how the gizmo drags a whole selection). */
export function offsetPositions(positions: Positions, delta: Vec3): Record<string, Vec3> {
  const after: Record<string, Vec3> = {};
  for (const [id, p] of Object.entries(positions)) {
    after[id] = [p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]];
  }
  return changed(positions, after);
}

/** The difference between two positions. */
export function positionDelta(from: Vec3, to: Vec3): Vec3 {
  return [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
}

/** Whether a delta is worth recording at all (a click is not a drag). */
export function isMove(delta: Vec3): boolean {
  return delta.some((v) => Math.abs(v) > 1e-6);
}
