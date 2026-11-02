/**
 * Colliders overlay model (play-mode debugger) — pure geometry for the
 * server's `colliders` debug answer: one line-segment buffer per shape
 * kind (box, sphere, capsule), so the view draws three batches however
 * many bodies there are. No three.js here; collider-overlay.tsx uploads
 * the buffers, and only when `colliderKey` says the set changed.
 */

import type { DebugCollider } from "@mmo-engine/protocol";

export interface ColliderLines {
  box: Float32Array;
  sphere: Float32Array;
  capsule: Float32Array;
}

/** Segments per ring (sphere: three rings, capsule: two). */
const RING = 16;
/** The 12 edges of a box as corner-index pairs (corner bit 0/1/2 = +x/+y/+z). */
const EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];
const corner = new Float32Array(24);

/** Append one line segment; returns the next write offset. */
function seg(out: Float32Array, o: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  out[o] = ax;
  out[o + 1] = ay;
  out[o + 2] = az;
  out[o + 3] = bx;
  out[o + 4] = by;
  out[o + 5] = bz;
  return o + 6;
}

/** A horizontal ring at height y. */
function ringXZ(out: Float32Array, o: number, cx: number, y: number, cz: number, r: number): number {
  for (let i = 0; i < RING; i++) {
    const a = (i / RING) * Math.PI * 2;
    const b = ((i + 1) / RING) * Math.PI * 2;
    o = seg(out, o, cx + Math.cos(a) * r, y, cz + Math.sin(a) * r, cx + Math.cos(b) * r, y, cz + Math.sin(b) * r);
  }
  return o;
}

export function colliderCounts(list: readonly DebugCollider[]): { box: number; sphere: number; capsule: number } {
  const n = { box: 0, sphere: 0, capsule: 0 };
  for (const c of list) n[c.shape === 0 ? "box" : c.shape === 1 ? "sphere" : "capsule"]++;
  return n;
}

export function colliderLines(list: readonly DebugCollider[]): ColliderLines {
  const n = colliderCounts(list);
  const box = new Float32Array(n.box * 12 * 6);
  const sphere = new Float32Array(n.sphere * 3 * RING * 6);
  const capsule = new Float32Array(n.capsule * (2 * RING + 4) * 6);
  let bo = 0;
  let so = 0;
  let co = 0;
  for (const c of list) {
    if (c.shape === 0) {
      const cos = Math.cos(c.yaw);
      const sin = Math.sin(c.yaw);
      for (let k = 0; k < 8; k++) {
        const lx = k & 1 ? c.hx : -c.hx;
        const lz = k & 4 ? c.hz : -c.hz;
        corner[k * 3] = c.x + lx * cos + lz * sin;
        corner[k * 3 + 1] = c.y + (k & 2 ? c.hy : -c.hy);
        corner[k * 3 + 2] = c.z - lx * sin + lz * cos;
      }
      for (let e = 0; e < EDGES.length; e += 2) {
        const a = EDGES[e] * 3;
        const b = EDGES[e + 1] * 3;
        bo = seg(box, bo, corner[a], corner[a + 1], corner[a + 2], corner[b], corner[b + 1], corner[b + 2]);
      }
    } else if (c.shape === 1) {
      // Three great circles: XZ, XY, ZY.
      so = ringXZ(sphere, so, c.x, c.y, c.z, c.r);
      for (let i = 0; i < RING; i++) {
        const a = (i / RING) * Math.PI * 2;
        const b = ((i + 1) / RING) * Math.PI * 2;
        so = seg(sphere, so, c.x + Math.cos(a) * c.r, c.y + Math.sin(a) * c.r, c.z, c.x + Math.cos(b) * c.r, c.y + Math.sin(b) * c.r, c.z);
        so = seg(sphere, so, c.x, c.y + Math.sin(a) * c.r, c.z + Math.cos(a) * c.r, c.x, c.y + Math.sin(b) * c.r, c.z + Math.cos(b) * c.r);
      }
    } else {
      // Feet at y: rings at the two hemisphere centres, four edges feet to head.
      const head = c.y + 2 * (c.hy + c.r);
      co = ringXZ(capsule, co, c.x, c.y + c.r, c.z, c.r);
      co = ringXZ(capsule, co, c.x, head - c.r, c.z, c.r);
      co = seg(capsule, co, c.x + c.r, c.y, c.z, c.x + c.r, head, c.z);
      co = seg(capsule, co, c.x - c.r, c.y, c.z, c.x - c.r, head, c.z);
      co = seg(capsule, co, c.x, c.y, c.z + c.r, c.x, head, c.z + c.r);
      co = seg(capsule, co, c.x, c.y, c.z - c.r, c.x, head, c.z - c.r);
    }
  }
  return { box, sphere, capsule };
}

/** A cheap fingerprint of the set (order-insensitive), so the view re-uploads only when it changes. */
export function colliderKey(list: readonly DebugCollider[]): string {
  let h = 0;
  for (const c of list) {
    h = (h + Math.fround(c.x * 31 + c.y * 17 + c.z * 13 + c.hx * 7 + c.hy * 5 + c.hz * 3 + c.r * 11 + c.yaw * 19 + Number(BigInt(c.id) % 100003n))) % 1e9;
  }
  return `${list.length}:${h}`;
}
