/**
 * Arrangements: how a room's items stand relative to each other and the room, the way that kind of room would be set out
 * (a row of coffins along a wall, pews in a grid, statues flanking a throne, candles ringing a circle).
 *
 * Pure geometry on the room's distance field: each pattern builds poses analytically, then keeps only the ones that fit
 * (on the room's own floor, clear of the walls by their radius, clear of what is already there and of each other).
 * They return fewer than asked when the room runs out; dress.ts scatters the rest. Poses are in grid cells; `rot` is the
 * facing angle (`atan2(ny, nx)`, as placement's wall items), so a pose's facing is the direction (cos rot, sin rot).
 */

import type { Placed, Sdf2 } from "@mmo-engine/placement";

export interface ArrangeCtx {
  /** Open floor positive, solid negative. */
  sdf: Sdf2;
  /** The room's own floor, off doorways (dress.ts's region test). */
  inside: (x: number, y: number) => boolean;
  /** What is already there: items keep clear of these. */
  taken: readonly Placed[];
  /** The room's centre. */
  centre: { x: number; y: number };
}

/** Clearance slack: a sampled distance field is only so exact, and the dressing checks clearance to this much. */
const EPS = 1e-3;
/** How far from the wall a row's items may drift (cells): a row follows the wall, it does not wander off it. */
const HUG = 0.15;

/** A pose of `radius` at (x, y) is valid: on the floor, off the walls, clear of everything placed. */
function fits(ctx: ArrangeCtx, placed: readonly Placed[], x: number, y: number, radius: number): boolean {
  if (!ctx.inside(x, y) || ctx.sdf.distance(x, y) < radius - EPS) return false;
  const clear = (p: Placed): boolean => (p.x - x) ** 2 + (p.y - y) ** 2 >= (p.radius + radius) ** 2 - EPS;
  return ctx.taken.every(clear) && placed.every(clear);
}

const pose = (x: number, y: number, rot: number, radius: number, n?: { nx: number; ny: number }): Placed => ({ x, y, rot, radius, ...(n ?? {}) });

/**
 * A straight row along a wall from `wall` (an item already settled against it: `nx, ny` its normal, `rot` facing out of the
 * wall): `wall`'s own spot, then alternately either side along the wall, `2 * radius + gap` apart, all facing as it does. Each
 * side stops at the first spot that does not fit (a corner, a bend in the wall, a door, something in the way): the dungeon's
 * walls are grid stair-steps, so a row is as long as the wall is straight.
 */
export function layRow(ctx: ArrangeCtx, wall: Placed, radius: number, count: number, gap: number): Placed[] {
  const out: Placed[] = [];
  if (count <= 0 || !fits(ctx, out, wall.x, wall.y, radius)) return out;
  const nx = wall.nx ?? Math.cos(wall.rot);
  const ny = wall.ny ?? Math.sin(wall.rot);
  const [tx, ty] = [-ny, nx];
  const pitch = 2 * radius + gap;
  const at = (k: number): Placed => pose(wall.x + tx * k * pitch, wall.y + ty * k * pitch, wall.rot, radius, { nx, ny });
  out.push(at(0));
  const open = { plus: true, minus: true };
  for (let k = 1; out.length < count && (open.plus || open.minus); k++) {
    for (const side of ["plus", "minus"] as const) {
      if (out.length >= count || !open[side]) continue;
      const p = at(side === "plus" ? k : -k);
      if (fits(ctx, out, p.x, p.y, radius) && ctx.sdf.distance(p.x, p.y) <= radius + HUG) out.push(p);
      else open[side] = false;
    }
  }
  return out;
}

/**
 * A lattice of pitch `2 * radius + gap` through the room's centre, axes aligned, filled row by row from the centre row outward
 * (a row of pews across the room, then the rows either side). All items share one facing: toward `faceTo` (from the centre)
 * when given, snapped to the nearest axis so the rows stay square to it, else +y.
 */
export function layGrid(ctx: ArrangeCtx, radius: number, count: number, gap: number, faceTo: { x: number; y: number } | null): Placed[] {
  const out: Placed[] = [];
  if (count <= 0) return out;
  const pitch = 2 * radius + gap;
  const rot = faceTo ? Math.round(Math.atan2(faceTo.y - ctx.centre.y, faceTo.x - ctx.centre.x) / (Math.PI / 2)) * (Math.PI / 2) : Math.PI / 2;
  const reach = Math.ceil(32 / pitch);
  const lattice: { i: number; j: number }[] = [];
  for (let j = -reach; j <= reach; j++) for (let i = -reach; i <= reach; i++) lattice.push({ i, j });
  lattice.sort((a, b) => Math.abs(a.j) - Math.abs(b.j) || a.j - b.j || Math.abs(a.i) - Math.abs(b.i) || a.i - b.i);
  for (const { i, j } of lattice) {
    if (out.length >= count) break;
    const x = ctx.centre.x + i * pitch;
    const y = ctx.centre.y + j * pitch;
    if (fits(ctx, out, x, y, radius)) out.push(pose(x, y, rot, radius));
  }
  return out;
}

/**
 * Items beside `anchor` along its width (perpendicular to its facing), facing as it does. `sides` 2 alternates either side
 * (statues flanking a throne); 1 stacks on one side, the one with room for more (an anvil beside its smelter). Each side stops
 * at the first spot that does not fit.
 */
export function layFlank(ctx: ArrangeCtx, anchor: Placed, radius: number, count: number, gap: number, sides: 1 | 2): Placed[] {
  if (count <= 0) return [];
  const [tx, ty] = [-Math.sin(anchor.rot), Math.cos(anchor.rot)];
  const first = anchor.radius + radius + gap;
  const pitch = 2 * radius + gap;
  const normal = anchor.nx !== undefined && anchor.ny !== undefined ? { nx: anchor.nx, ny: anchor.ny } : undefined;
  const at = (sign: number, k: number): Placed => {
    const d = (first + k * pitch) * sign;
    return pose(anchor.x + tx * d, anchor.y + ty * d, anchor.rot, radius, normal);
  };
  /** Up to `n` on one side, nearest the anchor first, stopping at the first that does not fit. */
  const stack = (sign: number, n: number, already: readonly Placed[]): Placed[] => {
    const out: Placed[] = [];
    for (let k = 0; k < n; k++) {
      const p = at(sign, k);
      if (!fits(ctx, [...already, ...out], p.x, p.y, radius)) break;
      out.push(p);
    }
    return out;
  };
  if (sides === 1) {
    const plus = stack(1, count, []);
    return plus.length >= count ? plus : [plus, stack(-1, count, [])].reduce((best, s) => (s.length > best.length ? s : best));
  }
  const out: Placed[] = [];
  const open = { plus: true, minus: true };
  for (let k = 0; out.length < count && (open.plus || open.minus); k++) {
    for (const side of ["plus", "minus"] as const) {
      if (out.length >= count || !open[side]) continue;
      const p = at(side === "plus" ? 1 : -1, k);
      if (fits(ctx, out, p.x, p.y, radius)) out.push(p);
      else open[side] = false;
    }
  }
  return out;
}

/** Items evenly round `anchor`, starting from its facing, facing it ("in") or away ("out"); the ones that do not fit are skipped. */
export function layRing(ctx: ArrangeCtx, anchor: Placed, radius: number, count: number, gap: number, face: "in" | "out"): Placed[] {
  const out: Placed[] = [];
  if (count <= 0) return out;
  const R = anchor.radius + radius + gap;
  for (let i = 0; i < count; i++) {
    const a = anchor.rot + (2 * Math.PI * i) / count;
    const [x, y] = [anchor.x + R * Math.cos(a), anchor.y + R * Math.sin(a)];
    if (fits(ctx, out, x, y, radius)) out.push(pose(x, y, face === "in" ? a + Math.PI : a, radius));
  }
  return out;
}
