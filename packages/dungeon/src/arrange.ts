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

const EPS = 1e-6;

/** A pose of `radius` at (x, y) is valid: on the floor, off the walls, clear of everything placed. */
function fits(ctx: ArrangeCtx, placed: readonly Placed[], x: number, y: number, radius: number): boolean {
  if (!ctx.inside(x, y) || ctx.sdf.distance(x, y) < radius - EPS) return false;
  const clear = (p: Placed): boolean => (p.x - x) ** 2 + (p.y - y) ** 2 >= (p.radius + radius) ** 2 - EPS;
  return ctx.taken.every(clear) && placed.every(clear);
}

const pose = (x: number, y: number, rot: number, radius: number, n?: { nx: number; ny: number }): Placed => ({ x, y, rot, radius, ...(n ?? {}) });

/**
 * A row along a wall from `wall` (an item already settled against it: `nx, ny` its normal, `rot` facing out of the wall):
 * `wall`'s own spot, then alternately either side along the wall, `2 * radius + gap` apart, each side stopping at the first
 * spot that does not fit (a corner, a door, something in the way).
 */
export function layRow(ctx: ArrangeCtx, wall: Placed, radius: number, count: number, gap: number): Placed[] {
  const out: Placed[] = [];
  if (count <= 0) return out;
  const nx = wall.nx ?? Math.cos(wall.rot);
  const ny = wall.ny ?? Math.sin(wall.rot);
  const [tx, ty] = [-ny, nx];
  const pitch = 2 * radius + gap;
  const at = (k: number): Placed => pose(wall.x + tx * k * pitch, wall.y + ty * k * pitch, wall.rot, radius, { nx, ny });
  if (!fits(ctx, out, wall.x, wall.y, radius)) return out;
  out.push(at(0));
  const open = { plus: true, minus: true };
  for (let k = 1; out.length < count && (open.plus || open.minus); k++) {
    for (const side of ["plus", "minus"] as const) {
      if (out.length >= count || !open[side]) continue;
      const p = at(side === "plus" ? k : -k);
      if (fits(ctx, out, p.x, p.y, radius)) out.push(p);
      else open[side] = false;
    }
  }
  return out;
}

/**
 * A lattice of pitch `2 * radius + gap` through the room's centre, axes aligned, filled from the centre outward. All items
 * share one facing: toward `faceTo` (from the centre) when given, else +y.
 */
export function layGrid(ctx: ArrangeCtx, radius: number, count: number, gap: number, faceTo: { x: number; y: number } | null): Placed[] {
  const out: Placed[] = [];
  if (count <= 0) return out;
  const pitch = 2 * radius + gap;
  const rot = faceTo ? Math.atan2(faceTo.y - ctx.centre.y, faceTo.x - ctx.centre.x) : Math.PI / 2;
  const reach = Math.ceil(32 / pitch);
  const lattice: { i: number; j: number }[] = [];
  for (let j = -reach; j <= reach; j++) for (let i = -reach; i <= reach; i++) lattice.push({ i, j });
  lattice.sort((a, b) => a.i * a.i + a.j * a.j - (b.i * b.i + b.j * b.j) || a.j - b.j || a.i - b.i);
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
 * (statues flanking a throne), 1 stacks on one side (an anvil beside its smelter). Each side stops at the first spot that does
 * not fit.
 */
export function layFlank(ctx: ArrangeCtx, anchor: Placed, radius: number, count: number, gap: number, sides: 1 | 2): Placed[] {
  const out: Placed[] = [];
  if (count <= 0) return out;
  const [tx, ty] = [-Math.sin(anchor.rot), Math.cos(anchor.rot)];
  const first = anchor.radius + radius + gap;
  const pitch = 2 * radius + gap;
  const open = { plus: true, minus: sides === 2 };
  for (let k = 0; out.length < count && (open.plus || open.minus); k++) {
    for (const side of ["plus", "minus"] as const) {
      if (out.length >= count || !open[side]) continue;
      const d = (first + k * pitch) * (side === "plus" ? 1 : -1);
      const [x, y] = [anchor.x + tx * d, anchor.y + ty * d];
      if (fits(ctx, out, x, y, radius)) out.push(pose(x, y, anchor.rot, radius, anchor.nx !== undefined && anchor.ny !== undefined ? { nx: anchor.nx, ny: anchor.ny } : undefined));
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
