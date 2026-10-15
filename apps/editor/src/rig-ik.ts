/**
 * Pure IK solvers for the Rig view: positions in, positions out, no three.js,
 * and nothing allocated per call (the caller owns the result objects and the
 * point buffer). The Rig scene turns the solved joint positions into bone
 * rotations; the same functions are what a client consumer would call.
 *
 *  - twoBoneIK: analytic hip-knee-foot. The foot target is clamped into the
 *    range the interior knee angle allows (so the limb never over-extends
 *    or folds through itself) and the knee goes to the pole's side, which is
 *    the only side it can bend.
 *  - fabrik: forward/backward reaching for longer chains (tail, spine, neck)
 *    with the root pinned, exact bone lengths and an optional bend limit per
 *    joint.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface TwoBoneResult {
  mid: Vec3;
  end: Vec3;
  /** False when the target was out of range (or outside the joint limits) and the end was clamped. */
  reached: boolean;
  /** The angle at the mid joint between the two bones (radians): pi is a straight limb. */
  interior: number;
}

export const newTwoBone = (): TwoBoneResult => ({ mid: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 0 }, reached: true, interior: Math.PI });

const EPS = 1e-9;
const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);

/**
 * Solve hip `root` -> knee -> foot for bones of length `l1` and `l2` reaching
 * `target`. `pole` is the direction the knee points (it need not be
 * perpendicular to the limb). The knee's interior angle stays within
 * [minInterior, maxInterior] radians (0 folded flat, pi straight).
 */
export function twoBoneIK(root: Vec3, l1: number, l2: number, target: Vec3, pole: Vec3, minInterior: number, maxInterior: number, out: TwoBoneResult): TwoBoneResult {
  const lo = clamp(minInterior, 0, Math.PI);
  const hi = clamp(Math.max(maxInterior, lo), 0, Math.PI);
  let dx = target.x - root.x;
  let dy = target.y - root.y;
  let dz = target.z - root.z;
  const d = Math.hypot(dx, dy, dz);
  // The reach each limit allows (law of cosines): folded is short, straight is long.
  const reachAt = (theta: number): number => Math.sqrt(Math.max(0, l1 * l1 + l2 * l2 - 2 * l1 * l2 * Math.cos(theta)));
  const dMin = reachAt(lo);
  const dMax = reachAt(hi);
  const c = Math.max(clamp(d, dMin, dMax), EPS);
  out.reached = c === d;
  if (d < EPS) {
    // Aimed at the hip itself: any direction will do, take straight down.
    dx = 0;
    dy = -1;
    dz = 0;
  } else {
    dx /= d;
    dy /= d;
    dz /= d;
  }
  // Where along the limb axis the knee projects, and how far it stands off it.
  const a = (l1 * l1 - l2 * l2 + c * c) / (2 * c);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  // Pole with its component along the axis removed.
  const along = pole.x * dx + pole.y * dy + pole.z * dz;
  let px = pole.x - dx * along;
  let py = pole.y - dy * along;
  let pz = pole.z - dz * along;
  let pl = Math.hypot(px, py, pz);
  if (pl < 1e-6) {
    // Pole parallel to the limb: use any perpendicular (the axis crossed with the least aligned world axis).
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    if (ax <= ay && ax <= az) { px = 0; py = dz; pz = -dy; }
    else if (ay <= az) { px = -dz; py = 0; pz = dx; }
    else { px = dy; py = -dx; pz = 0; }
    pl = Math.hypot(px, py, pz) || 1;
  }
  px /= pl;
  py /= pl;
  pz /= pl;
  out.mid.x = root.x + dx * a + px * h;
  out.mid.y = root.y + dy * a + py * h;
  out.mid.z = root.z + dz * a + pz * h;
  out.end.x = root.x + dx * c;
  out.end.y = root.y + dy * c;
  out.end.z = root.z + dz * c;
  out.interior = Math.acos(clamp((l1 * l1 + l2 * l2 - c * c) / (2 * l1 * l2), -1, 1));
  return out;
}

export interface FabrikOptions {
  iterations: number;
  /** Stop when the end is this close to the target (metres). */
  tolerance: number;
  /** Largest angle (radians) between neighbouring bones at any joint; unlimited when absent. */
  maxBend?: number;
}
export interface FabrikResult {
  iterations: number;
  /** Distance from the end to the target after solving. */
  error: number;
  reached: boolean;
}
const result: FabrikResult = { iterations: 0, error: 0, reached: false };

/**
 * Solve a chain in place. `pts` holds n xyz triples (root first), `lens` the n-1 bone lengths.
 * The root never moves and every length stays exact, also when a bend limit stops the end short.
 * The returned object is reused by the next call.
 */
export function fabrik(pts: Float64Array, lens: Float64Array, target: Vec3, opt: FabrikOptions): FabrikResult {
  const n = lens.length + 1;
  const end = (n - 1) * 3;
  const rx = pts[0], ry = pts[1], rz = pts[2];
  let total = 0;
  for (let i = 0; i < n - 1; i++) total += lens[i];
  const err = (): number => Math.hypot(pts[end] - target.x, pts[end + 1] - target.y, pts[end + 2] - target.z);
  const dRoot = Math.hypot(target.x - rx, target.y - ry, target.z - rz);

  if (dRoot >= total) {
    // Out of reach: lay the chain straight at the target.
    const k = dRoot < EPS ? 0 : 1 / dRoot;
    const ux = dRoot < EPS ? 0 : (target.x - rx) * k, uy = dRoot < EPS ? -1 : (target.y - ry) * k, uz = dRoot < EPS ? 0 : (target.z - rz) * k;
    let s = 0;
    for (let i = 1; i < n; i++) {
      s += lens[i - 1];
      pts[i * 3] = rx + ux * s;
      pts[i * 3 + 1] = ry + uy * s;
      pts[i * 3 + 2] = rz + uz * s;
    }
    result.iterations = 0;
    result.error = err();
    result.reached = false;
    return result;
  }

  let it = 0;
  for (; it < opt.iterations && err() > opt.tolerance; it++) {
    // Backward: the end goes to the target, each joint is pulled back to its bone length from the next.
    pts[end] = target.x;
    pts[end + 1] = target.y;
    pts[end + 2] = target.z;
    for (let i = n - 2; i >= 0; i--) place(pts, i, i + 1, lens[i]);
    // Forward: the root goes back, each joint is pushed out to its bone length from the previous.
    pts[0] = rx;
    pts[1] = ry;
    pts[2] = rz;
    for (let i = 1; i < n; i++) place(pts, i, i - 1, lens[i - 1]);
    if (opt.maxBend !== undefined) limitBends(pts, lens, n, opt.maxBend);
  }
  result.iterations = it;
  result.error = err();
  result.reached = result.error <= opt.tolerance;
  return result;
}

/** Put point `i` at distance `len` from point `from`, on the line it was on. */
function place(p: Float64Array, i: number, from: number, len: number): void {
  let dx = p[i * 3] - p[from * 3];
  let dy = p[i * 3 + 1] - p[from * 3 + 1];
  let dz = p[i * 3 + 2] - p[from * 3 + 2];
  const d = Math.hypot(dx, dy, dz);
  if (d < EPS) {
    dx = 0;
    dy = -1;
    dz = 0;
  } else {
    dx /= d;
    dy /= d;
    dz /= d;
  }
  p[i * 3] = p[from * 3] + dx * len;
  p[i * 3 + 1] = p[from * 3 + 1] + dy * len;
  p[i * 3 + 2] = p[from * 3 + 2] + dz * len;
}

/** Root to tip: at each joint, turn the next bone back toward the previous one's direction until the bend is within `max`; the rest of the chain moves rigidly with it. */
function limitBends(p: Float64Array, lens: Float64Array, n: number, max: number): void {
  const cosMax = Math.cos(max);
  const sinMax = Math.sin(max);
  for (let i = 1; i < n - 1; i++) {
    let ax = p[i * 3] - p[i * 3 - 3], ay = p[i * 3 + 1] - p[i * 3 - 2], az = p[i * 3 + 2] - p[i * 3 - 1];
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al; ay /= al; az /= al;
    let bx = p[i * 3 + 3] - p[i * 3], by = p[i * 3 + 4] - p[i * 3 + 1], bz = p[i * 3 + 5] - p[i * 3 + 2];
    const bl = Math.hypot(bx, by, bz) || 1;
    bx /= bl; by /= bl; bz /= bl;
    const cos = ax * bx + ay * by + az * bz;
    if (cos >= cosMax) continue;
    // Component of b perpendicular to a; the limited direction is a rotated by `max` toward it.
    let qx = bx - ax * cos, qy = by - ay * cos, qz = bz - az * cos;
    const ql = Math.hypot(qx, qy, qz);
    if (ql < EPS) {
      // Folded straight back: any perpendicular to a.
      if (Math.abs(ax) < 0.9) { qx = 0; qy = -az; qz = ay; } else { qx = -ay; qy = ax; qz = 0; }
      const l2 = Math.hypot(qx, qy, qz) || 1;
      qx /= l2; qy /= l2; qz /= l2;
    } else {
      qx /= ql; qy /= ql; qz /= ql;
    }
    const nx = ax * cosMax + qx * sinMax, ny = ay * cosMax + qy * sinMax, nz = az * cosMax + qz * sinMax;
    const tx = p[i * 3] + nx * lens[i] - p[i * 3 + 3];
    const ty = p[i * 3 + 1] + ny * lens[i] - p[i * 3 + 4];
    const tz = p[i * 3 + 2] + nz * lens[i] - p[i * 3 + 5];
    for (let j = i + 1; j < n; j++) {
      p[j * 3] += tx;
      p[j * 3 + 1] += ty;
      p[j * 3 + 2] += tz;
    }
  }
}
