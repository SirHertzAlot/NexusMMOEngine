/**
 * Tick interpolation for the mirror renderer.
 *
 * The server simulates at 30 Hz; the browser renders at rAF (~60 Hz).
 * The Interpolator keeps the previous and current authoritative
 * Transform per entity and samples between them at alpha in [0, 1]:
 *   alpha = (now - lastTickTime) / tickInterval, clamped.
 *
 * Position and scale lerp; rotation lerps then normalizes (cheap nlerp —
 * fine for placeholder visuals; a real slerp can replace it later).
 * Entities seen in only one of the two ticks, or with equal ticks,
 * sample to their latest known transform (no extrapolation — the
 * mirror never guesses ahead of the authority).
 *
 * No client prediction yet — that is a later slice (architecture
 * brief §5, open question 4). The mirror renders strictly behind the
 * server by one tick interval.
 */

import type { TransformRow } from "@mmo-engine/protocol";

export interface InterpolatedTransform {
  px: number; py: number; pz: number;
  qx: number; qy: number; qz: number; qw: number;
  sx: number; sy: number; sz: number;
}

interface Frame {
  prev: TransformRow;
  curr: TransformRow;
  prevTick: number;
  currTick: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function nlerpQuat(
  a: TransformRow,
  b: TransformRow,
  t: number,
): [number, number, number, number] {
  let x = a.qx + (b.qx - a.qx) * t;
  let y = a.qy + (b.qy - a.qy) * t;
  let z = a.qz + (b.qz - a.qz) * t;
  let w = a.qw + (b.qw - a.qw) * t;
  const len = Math.hypot(x, y, z, w) || 1;
  x /= len; y /= len; z /= len; w /= len;
  return [x, y, z, w];
}

export class Interpolator {
  private readonly frames = new Map<bigint, Frame>();

  /**
   * Push the transform rows of one applied tick. Rows for entities
   * already seen shift curr -> prev; brand-new entities seed both
   * frames with the same row (no interpolation until the next tick).
   */
  push(tick: number, rows: TransformRow[]): void {
    for (const row of rows) {
      const f = this.frames.get(row.wireId);
      if (f && f.currTick !== tick) {
        f.prev = f.curr;
        f.prevTick = f.currTick;
        f.curr = row;
        f.currTick = tick;
      } else if (!f) {
        this.frames.set(row.wireId, {
          prev: row,
          curr: row,
          prevTick: tick,
          currTick: tick,
        });
      }
      // Same-tick duplicate (snapshot + delta in one tick): keep first.
    }
  }

  /** Drop interpolation history for a despawned entity. */
  remove(wireId: bigint): void {
    this.frames.delete(wireId);
  }

  /** Clear all history (e.g. on a fresh snapshot / reconnect). */
  clear(): void {
    this.frames.clear();
  }

  /** Sample the interpolated transform for one entity. */
  sample(wireId: bigint, alpha: number): InterpolatedTransform | undefined {
    const f = this.frames.get(wireId);
    if (!f) return undefined;
    const t = clamp01(alpha);
    if (f.prevTick === f.currTick || t === 1) {
      const c = f.curr;
      return {
        px: c.px, py: c.py, pz: c.pz,
        qx: c.qx, qy: c.qy, qz: c.qz, qw: c.qw,
        sx: c.sx, sy: c.sy, sz: c.sz,
      };
    }
    const [qx, qy, qz, qw] = nlerpQuat(f.prev, f.curr, t);
    const lerp = (a: number, b: number): number => a + (b - a) * t;
    return {
      px: lerp(f.prev.px, f.curr.px),
      py: lerp(f.prev.py, f.curr.py),
      pz: lerp(f.prev.pz, f.curr.pz),
      qx, qy, qz, qw,
      sx: lerp(f.prev.sx, f.curr.sx),
      sy: lerp(f.prev.sy, f.curr.sy),
      sz: lerp(f.prev.sz, f.curr.sz),
    };
  }

  /** Wire ids with interpolation history (for the renderer to sweep). */
  keys(): IterableIterator<bigint> {
    return this.frames.keys();
  }
}
