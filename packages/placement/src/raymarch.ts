/**
 * Sphere tracing: from an origin along a direction, step by the distance
 * field's value (nothing can be nearer than that), until the field is
 * within `epsilon` of a surface (a hit) or the ray runs out. The surface
 * normal is the field's gradient there.
 */

import type { Sdf2, Sdf3 } from "./sdf.js";

export interface MarchOptions {
  /** Give up after this far (world units). */
  maxDistance: number;
  /** A hit: the field within this of zero (default 1e-3). */
  epsilon?: number;
  maxSteps?: number;
}

export interface Hit2 {
  x: number;
  y: number;
  /** How far along the ray. */
  t: number;
  /** Unit normal of the surface hit (pointing into open space). */
  nx: number;
  ny: number;
}

export interface Hit3 {
  x: number;
  y: number;
  z: number;
  t: number;
  nx: number;
  ny: number;
  nz: number;
}

/** The field's gradient at (x, y), normalised: the direction away from the nearest surface. */
export function normal2(sdf: Sdf2, x: number, y: number, h = 1e-3): [number, number] {
  const gx = sdf.distance(x + h, y) - sdf.distance(x - h, y);
  const gy = sdf.distance(x, y + h) - sdf.distance(x, y - h);
  const len = Math.hypot(gx, gy) || 1;
  return [gx / len, gy / len];
}

export function normal3(sdf: Sdf3, x: number, y: number, z: number, h = 1e-3): [number, number, number] {
  const gx = sdf.distance(x + h, y, z) - sdf.distance(x - h, y, z);
  const gy = sdf.distance(x, y + h, z) - sdf.distance(x, y - h, z);
  const gz = sdf.distance(x, y, z + h) - sdf.distance(x, y, z - h);
  const len = Math.hypot(gx, gy, gz) || 1;
  return [gx / len, gy / len, gz / len];
}

/** March from (ox, oy) along (dx, dy); the direction needn't be unit length. */
export function march2(sdf: Sdf2, ox: number, oy: number, dx: number, dy: number, o: MarchOptions): Hit2 | null {
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  dx /= len;
  dy /= len;
  const eps = o.epsilon ?? 1e-3;
  const steps = o.maxSteps ?? 256;
  let t = 0, prev = 0;
  for (let i = 0; i < steps && t <= o.maxDistance; i++) {
    let x = ox + dx * t, y = oy + dy * t;
    const d = sdf.distance(x, y);
    if (d < eps) {
      // A field that overestimates (a sampled one, near corners) can step
      // past the surface: bisect back to it between the last two steps.
      if (d < -eps) {
        // Starting inside a surface is no hit.
        if (i === 0) return null;
        let lo = prev, hi = t;
        for (let k = 0; k < 32; k++) {
          const mid = (lo + hi) / 2;
          if (sdf.distance(ox + dx * mid, oy + dy * mid) > 0) lo = mid;
          else hi = mid;
        }
        t = lo;
        x = ox + dx * t;
        y = oy + dy * t;
      }
      const [nx, ny] = normal2(sdf, x, y);
      return { x, y, t, nx, ny };
    }
    prev = t;
    t += d;
  }
  return null;
}

export function march3(sdf: Sdf3, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, o: MarchOptions): Hit3 | null {
  const len = Math.hypot(dx, dy, dz);
  if (len === 0) return null;
  dx /= len;
  dy /= len;
  dz /= len;
  const eps = o.epsilon ?? 1e-3;
  const steps = o.maxSteps ?? 256;
  let t = 0, prev = 0;
  for (let i = 0; i < steps && t <= o.maxDistance; i++) {
    let x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
    const d = sdf.distance(x, y, z);
    if (d < eps) {
      if (d < -eps) {
        if (i === 0) return null;
        // Overshot (see march2): bisect back to the surface.
        let lo = prev, hi = t;
        for (let k = 0; k < 32; k++) {
          const mid = (lo + hi) / 2;
          if (sdf.distance(ox + dx * mid, oy + dy * mid, oz + dz * mid) > 0) lo = mid;
          else hi = mid;
        }
        t = lo;
        x = ox + dx * t;
        y = oy + dy * t;
        z = oz + dz * t;
      }
      const [nx, ny, nz] = normal3(sdf, x, y, z);
      return { x, y, z, t, nx, ny, nz };
    }
    prev = t;
    t += d;
  }
  return null;
}
