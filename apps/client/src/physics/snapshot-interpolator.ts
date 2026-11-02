/**
 * SnapshotInterpolator: draws a shared body (one another player or a creature
 * the server simulates) between the server's snapshots. Snapshots arrive in
 * bursts and late, so the interpolator keeps a short buffer and draws every body
 * `delaySeconds` behind the clock. Between two snapshots it lerps position and
 * slerps rotation (shortest arc). Outside the buffer it holds the nearest
 * snapshot and never extrapolates ahead of the server.
 *
 * Cosmetic only. The local player uses WalkerPredictor instead.
 */

export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BodySnapshot {
  /** Server tick the transform is for. */
  readonly tick: number;
  readonly pos: Vec3;
  readonly quat: Quat;
}

export interface Pose {
  readonly pos: Vec3;
  readonly quat: Quat;
}

export interface SnapshotInterpolatorOptions {
  /** Seconds per server tick. */
  readonly tickSeconds: number;
  /** How far behind the clock bodies are drawn, seconds. */
  readonly delaySeconds: number;
  /** Snapshots kept; the oldest is dropped past this. */
  readonly capacity?: number;
}

const SLERP_NLERP_DOT = 0.9995;

export class SnapshotInterpolator {
  private readonly buf: BodySnapshot[] = [];
  private readonly capacity: number;

  constructor(private readonly options: SnapshotInterpolatorOptions) {
    this.capacity = options.capacity ?? 32;
  }

  get size(): number {
    return this.buf.length;
  }

  /**
   * Adds a snapshot. Ticks must increase: a duplicate or older tick (a late
   * packet) is ignored. Returns false when ignored.
   */
  push(snap: BodySnapshot): boolean {
    const last = this.buf[this.buf.length - 1];
    if (last && snap.tick <= last.tick) return false;
    this.buf.push(snap);
    if (this.buf.length > this.capacity) this.buf.shift();
    return true;
  }

  /**
   * The pose at server time `now` (seconds), drawn `delaySeconds` behind it.
   * Null when nothing has arrived yet.
   */
  sample(now: number): Pose | null {
    const n = this.buf.length;
    if (n === 0) return null;
    const { tickSeconds, delaySeconds } = this.options;
    const target = now - delaySeconds;
    const first = this.buf[0]!;
    const last = this.buf[n - 1]!;
    if (target <= first.tick * tickSeconds) return { pos: first.pos, quat: first.quat };
    if (target >= last.tick * tickSeconds) return { pos: last.pos, quat: last.quat };
    // Find the pair around target (buffer is short, so a linear scan is fine).
    for (let i = 1; i < n; i++) {
      const b = this.buf[i]!;
      const tb = b.tick * tickSeconds;
      if (target > tb) continue;
      const a = this.buf[i - 1]!;
      const ta = a.tick * tickSeconds;
      const t = (target - ta) / (tb - ta);
      return { pos: lerp3(a.pos, b.pos, t), quat: slerp(a.quat, b.quat, t) };
    }
    return { pos: last.pos, quat: last.quat };
  }
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/** Shortest-arc slerp; nlerp when the two rotations are nearly equal. Output is unit length. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  let dot = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  let wa: number, wb: number;
  if (dot > SLERP_NLERP_DOT) {
    wa = 1 - t;
    wb = t;
  } else {
    const theta = Math.acos(dot);
    const s = Math.sin(theta);
    wa = Math.sin((1 - t) * theta) / s;
    wb = Math.sin(t * theta) / s;
  }
  const x = a.x * wa + bx * wb;
  const y = a.y * wa + by * wb;
  const z = a.z * wa + bz * wb;
  const w = a.w * wa + bw * wb;
  const len = Math.hypot(x, y, z, w) || 1;
  return { x: x / len, y: y / len, z: z / len, w: w / len };
}
