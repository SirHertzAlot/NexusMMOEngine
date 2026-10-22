/**
 * Arrangements: how a room's items stand relative to each other and the room, the way that kind of room would be set out
 * (a row of coffins along a wall, pews in a grid, statues flanking a throne, candles ringing a circle, a footlocker at the
 * foot of every bunk).
 *
 * Pure geometry on the room's distance field: each pattern builds poses analytically, then keeps only the ones that fit
 * (on the room's own floor, clear of the walls, clear of what is already there and of each other). They return fewer than
 * asked when the room runs out; dress.ts scatters the rest. Poses are in grid cells; `rot` is the facing angle
 * (`atan2(ny, nx)`, as placement's wall items), so a pose's facing is the direction (cos rot, sin rot).
 *
 * An item is a lateral half-width `radius` (its clearance from neighbours) and, optionally, a `reach`: its half-length along
 * its facing (a coffin is slim but long). The centre of an item stands `reach` from the wall it backs onto, and the item in
 * front of it (a footlocker) stands `reach` further out. `reach` defaults to `radius`: a round item.
 */

import type { Placed, Sdf2 } from "@mmo-engine/placement";

export interface ArrangeCtx {
  /** Open floor positive, solid negative. */
  sdf: Sdf2;
  /** The room's own floor, off doorways (dress.ts's region test). */
  inside: (x: number, y: number) => boolean;
  /** What is already there: items keep clear of these (for a mounted call: the room's other mounted items). */
  taken: readonly Placed[];
  /** The room's centre. */
  centre: { x: number; y: number };
  /** The room's size in cells (`line` runs along the longer side). */
  extent?: { w: number; h: number };
}

/** Options shared by the patterns. */
export interface LayOpts {
  /** The item's half-length along its facing, cells (default: its radius). */
  reach?: number;
  /** Hung on the wall (a painting): on the wall surface, clear only of other mounted items. */
  mounted?: boolean;
  /** For a grid: the width (cells) of a lateral gap kept free down its middle, an aisle. */
  aisle?: number;
}

/** A pose that remembers its reach (what `layBefore` measures from). */
type Pose = Placed & { reach?: number };
/** The half-length along its facing of a pose this module made (its radius for any other). */
export const reachOf = (p: Placed): number => (p as Pose).reach ?? p.radius;

/** Clearance slack: a sampled distance field is only so exact, and the dressing checks clearance to this much. */
const EPS = 1e-3;
/** How far from the wall a row's items may drift (cells): a row follows the wall, it does not wander off it. */
const HUG = 0.15;
/** A mounted item hangs this far off the wall. */
const MOUNT = 0.01;

/** A pose of lateral `radius` at (x, y) is valid: on the floor, `wall` clear of the walls (0: on a wall surface), clear of everything placed. */
function fits(ctx: ArrangeCtx, placed: readonly Placed[], x: number, y: number, radius: number, wall = radius): boolean {
  if (!ctx.inside(x, y) || ctx.sdf.distance(x, y) < wall - EPS) return false;
  const clear = (p: Placed): boolean => (p.x - x) ** 2 + (p.y - y) ** 2 >= (p.radius + radius) ** 2 - EPS;
  return ctx.taken.every(clear) && placed.every(clear);
}

const pose = (x: number, y: number, rot: number, radius: number, reach: number, n?: { nx: number; ny: number }): Pose => ({ x, y, rot, radius, reach, ...(n ?? {}) });

/**
 * A straight row along a wall from `wall` (an item already settled against it: `nx, ny` its normal, `rot` facing out of the
 * wall, its centre `reach` from the wall, or on it for a mounted item): `wall`'s own spot, then alternately either side along
 * the wall, `2 * radius + gap` apart, all facing as it does. Each side stops at the first spot that does not fit (a corner, a
 * bend in the wall, a door, something in the way): the dungeon's walls are grid stair-steps, so a row is as long as the wall
 * is straight.
 */
export function layRow(ctx: ArrangeCtx, wall: Placed, radius: number, count: number, gap: number, o: LayOpts = {}): Placed[] {
  const out: Placed[] = [];
  const reach = o.reach ?? radius;
  const off = o.mounted ? 0 : reach;
  if (count <= 0 || !fits(ctx, out, wall.x, wall.y, radius, off)) return out;
  const nx = wall.nx ?? Math.cos(wall.rot);
  const ny = wall.ny ?? Math.sin(wall.rot);
  const [tx, ty] = [-ny, nx];
  const pitch = 2 * radius + gap;
  const at = (k: number): Placed => pose(wall.x + tx * k * pitch, wall.y + ty * k * pitch, wall.rot, radius, reach, { nx, ny });
  const hug = (p: Placed): boolean => ctx.sdf.distance(p.x, p.y) <= (o.mounted ? MOUNT : reach) + HUG;
  out.push(at(0));
  const open = { plus: true, minus: true };
  for (let k = 1; out.length < count && (open.plus || open.minus); k++) {
    for (const side of ["plus", "minus"] as const) {
      if (out.length >= count || !open[side]) continue;
      const p = at(side === "plus" ? k : -k);
      if (fits(ctx, out, p.x, p.y, radius, off) && hug(p)) out.push(p);
      else open[side] = false;
    }
  }
  return out;
}

/**
 * A lattice through the room's centre, axes aligned, filled row by row from the centre row outward (a row of pews across the
 * room, then the rows either side). Across the facing the pitch is `2 * radius + gap`, along it `2 * reach + gap`. All items
 * share one facing: toward `faceTo` (from the centre) when given, snapped to the nearest axis so the rows stay square to it, else +y.
 */
export function layGrid(ctx: ArrangeCtx, radius: number, count: number, gap: number, faceTo: { x: number; y: number } | null, o: LayOpts = {}): Placed[] {
  const out: Placed[] = [];
  if (count <= 0) return out;
  const reach = o.reach ?? radius;
  const rot = faceTo ? Math.round(Math.atan2(faceTo.y - ctx.centre.y, faceTo.x - ctx.centre.x) / (Math.PI / 2)) * (Math.PI / 2) : Math.PI / 2;
  const alongX = Math.abs(Math.cos(rot)) > 0.5;
  const [pitchX, pitchY] = alongX ? [2 * reach + gap, 2 * radius + gap] : [2 * radius + gap, 2 * reach + gap];
  // Facing an anchor, the lattice is centred on the anchor's axis (the pews are square to the altar), else on the room's centre.
  const origin = faceTo ? (alongX ? { x: ctx.centre.x, y: faceTo.y } : { x: faceTo.x, y: ctx.centre.y }) : ctx.centre;
  const span = Math.ceil(32 / Math.min(pitchX, pitchY));
  const lattice: { i: number; j: number }[] = [];
  for (let j = -span; j <= span; j++) for (let i = -span; i <= span; i++) lattice.push({ i, j });
  // Rows run across the facing. Facing an anchor the rows nearest it fill first (the front pews); otherwise from the centre row outward.
  const rowKey = (l: { i: number; j: number }): number => {
    if (faceTo) return alongX ? Math.abs(origin.x + l.i * pitchX - faceTo.x) : Math.abs(origin.y + l.j * pitchY - faceTo.y);
    return alongX ? Math.abs(l.i) : Math.abs(l.j);
  };
  const lateral = (l: { i: number; j: number }): number => (alongX ? Math.abs(l.j) : Math.abs(l.i));
  lattice.sort((a, b) => rowKey(a) - rowKey(b) || (alongX ? a.i - b.i : a.j - b.j) || lateral(a) - lateral(b) || (alongX ? a.j - b.j : a.i - b.i));
  const aisle = (o.aisle ?? 0) / 2;
  for (const l of lattice) {
    if (out.length >= count) break;
    const [dx, dy] = [l.i * pitchX, l.j * pitchY];
    if (aisle > 0 && Math.abs(alongX ? dy : dx) < aisle) continue;
    const x = origin.x + dx;
    const y = origin.y + dy;
    // Facing an anchor, every item is in front of it (at least a cell off), none beside it or behind it.
    if (faceTo && (faceTo.x - x) * Math.cos(rot) + (faceTo.y - y) * Math.sin(rot) < 1) continue;
    if (fits(ctx, out, x, y, radius, reach)) out.push(pose(x, y, rot, radius, reach));
  }
  return out;
}

/**
 * Items down the room's long axis through its centre, `at` cells off the centreline, `2 * reach + gap` apart (they face along the line), filled from the
 * middle outward (a carpet runner, a hall of pillars, sarcophagi down a crypt); facing along the axis. Spots that do not fit are skipped.
 */
export function layLine(ctx: ArrangeCtx, radius: number, count: number, gap: number, at: number, o: LayOpts = {}): Placed[] {
  const out: Placed[] = [];
  if (count <= 0) return out;
  const reach = o.reach ?? radius;
  const alongX = (ctx.extent?.w ?? 1) >= (ctx.extent?.h ?? 0);
  const rot = alongX ? 0 : Math.PI / 2;
  // Items face along the line, so what spaces them is their length (`reach`), not their width.
  const pitch = 2 * reach + gap;
  const span = Math.ceil((alongX ? ctx.extent?.w ?? 64 : ctx.extent?.h ?? 64) / pitch);
  for (let k = 0; out.length < count && k <= span; k++) {
    for (const sign of k === 0 ? [1] : [1, -1]) {
      if (out.length >= count) break;
      const d = sign * k * pitch;
      const [x, y] = alongX ? [ctx.centre.x + d, ctx.centre.y + at] : [ctx.centre.x + at, ctx.centre.y + d];
      if (fits(ctx, out, x, y, radius, reach)) out.push(pose(x, y, rot, radius, reach));
    }
  }
  return out;
}

/**
 * One item in front of each of `anchors` (the foot of every bunk, a bench before every table): `reach` beyond the anchor's own
 * reach plus `gap`, along its facing, facing as it does. Anchors with no room in front get none.
 */
export function layBefore(ctx: ArrangeCtx, anchors: readonly Placed[], radius: number, gap: number, o: LayOpts = {}): Placed[] {
  const out: Placed[] = [];
  const reach = o.reach ?? radius;
  // Standing in front of an anchor is not "overlapping" it: the anchors' own footprints (circles of their longest side) are not in the way.
  const isAnchor = (t: Placed): boolean => anchors.some((a) => Math.abs(a.x - t.x) < 1e-9 && Math.abs(a.y - t.y) < 1e-9);
  const rest: ArrangeCtx = { ...ctx, taken: ctx.taken.filter((t) => !isAnchor(t)) };
  for (const a of anchors) {
    const d = reachOf(a) + reach + gap;
    const [x, y] = [a.x + Math.cos(a.rot) * d, a.y + Math.sin(a.rot) * d];
    if (fits(rest, out, x, y, radius)) out.push(pose(x, y, a.rot, radius, reach));
  }
  return out;
}

/**
 * Items beside `anchor` along its width (perpendicular to its facing), facing as it does. `sides` 2 alternates either side
 * (statues flanking a throne); 1 stacks on one side, the one with room for more (an anvil beside its smelter). Each side stops
 * at the first spot that does not fit.
 */
export function layFlank(ctx: ArrangeCtx, anchor: Placed, radius: number, count: number, gap: number, sides: 1 | 2, o: LayOpts = {}): Placed[] {
  if (count <= 0) return [];
  const reach = o.reach ?? radius;
  const [tx, ty] = [-Math.sin(anchor.rot), Math.cos(anchor.rot)];
  const first = anchor.radius + radius + gap;
  const pitch = 2 * radius + gap;
  const normal = anchor.nx !== undefined && anchor.ny !== undefined ? { nx: anchor.nx, ny: anchor.ny } : undefined;
  const at = (sign: number, k: number): Placed => {
    const d = (first + k * pitch) * sign;
    return pose(anchor.x + tx * d, anchor.y + ty * d, anchor.rot, radius, reach, normal);
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
export function layRing(ctx: ArrangeCtx, anchor: Placed, radius: number, count: number, gap: number, face: "in" | "out", o: LayOpts = {}): Placed[] {
  const out: Placed[] = [];
  if (count <= 0) return out;
  const reach = o.reach ?? radius;
  const R = anchor.radius + radius + gap;
  for (let i = 0; i < count; i++) {
    const a = anchor.rot + (2 * Math.PI * i) / count;
    const [x, y] = [anchor.x + R * Math.cos(a), anchor.y + R * Math.sin(a)];
    if (fits(ctx, out, x, y, radius)) out.push(pose(x, y, face === "in" ? a + Math.PI : a, radius, reach));
  }
  return out;
}

/**
 * One item at the head of the room: against the wall, in the middle of that wall's free run (the patron's statue behind an altar).
 * `seeds` are wall-settled spots round the walls (placement's wall items); each is stretched into the run of wall it sits on, and the
 * item goes in the middle of the longest run, facing out of the wall. Returns [] when nothing fits.
 */
export function layHead(ctx: ArrangeCtx, seeds: readonly Placed[], radius: number, o: LayOpts = {}): Placed[] {
  const reach = o.reach ?? radius;
  let best: { run: number; pos: Placed } | null = null;
  for (const seed of seeds) {
    // The run: a row of tiny probes along the wall each way from the seed, as far as the wall is straight and free.
    const probes = layRow(ctx, seed, 0.05, 400, 0, { reach });
    if (probes.length === 0) continue;
    const nx = seed.nx ?? Math.cos(seed.rot);
    const ny = seed.ny ?? Math.sin(seed.rot);
    const along = probes.map((p) => (p.x - seed.x) * -ny + (p.y - seed.y) * nx);
    const [lo, hi] = [Math.min(...along), Math.max(...along)];
    const mid = (lo + hi) / 2;
    const pos = pose(seed.x - ny * mid, seed.y + nx * mid, seed.rot, radius, reach, { nx, ny });
    if (fits(ctx, [], pos.x, pos.y, radius, reach) && (!best || hi - lo > best.run)) best = { run: hi - lo, pos };
  }
  return best ? [best.pos] : [];
}
