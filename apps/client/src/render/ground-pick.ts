/**
 * Ground pick for the editor's place-at-cursor (roadmap E4): where a view
 * ray meets the ground. The ground is a height field (TerrainRenderer's
 * heightAt), so the ray is walked to it: intersect a horizontal plane at
 * the current height guess, read the terrain height under that point, and
 * repeat until the guess stops moving. Null when the ray points at the sky,
 * or the point is off the streamed terrain (no height there).
 */

export interface RayLike {
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
}

export interface HeightSource {
  heightAt(x: number, z: number): number | null;
}

const MAX_STEPS = 8;
const SETTLE_M = 0.05;

export function groundPoint(ray: RayLike, ground: HeightSource, startY: number): { x: number; z: number } | null {
  let y = startY;
  let x = 0;
  let z = 0;
  for (let i = 0; i < MAX_STEPS; i++) {
    if (Math.abs(ray.dy) < 1e-9) return null;
    const t = (y - ray.oy) / ray.dy;
    if (t < 0) return null;
    x = ray.ox + ray.dx * t;
    z = ray.oz + ray.dz * t;
    const h = ground.heightAt(x, z);
    if (h === null) return null;
    if (Math.abs(h - y) < SETTLE_M) return { x, z };
    y = h;
  }
  return { x, z };
}
