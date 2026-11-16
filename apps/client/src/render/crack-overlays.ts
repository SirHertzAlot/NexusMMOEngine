/**
 * Procedural fracture overlays (DE1): draws crisp crack patterns on damaged breakables
 * (props, walls, buildings) across 3 batched InstancedMesh severity levels so dozens of
 * damaged structures add at most 3 draw calls and bounded GPU memory.
 */

import * as THREE from "three";
import type { BodyConfigRow, TransformRow } from "@mmo-engine/protocol";

export const MAX_CRACK_OVERLAYS = 128;

export type CrackSeverity = 1 | 2 | 3;

interface CrackEntry {
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  sx: number;
  sy: number;
  sz: number;
  level: CrackSeverity;
}

const tmpMatrix = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();

/** Map a `(stage, totalStages)` pair to one of 3 visual crack tiers (0 = intact). */
export function crackSeverity(stage: number, totalStages: number): 0 | CrackSeverity {
  if (stage <= 0) return 0;
  const n = Math.max(1, totalStages);
  const scaled = Math.ceil((Math.min(stage, n) / n) * 3);
  if (scaled <= 1) return 1;
  if (scaled === 2) return 2;
  return 3;
}

function nextRand(seed: { v: number }): number {
  seed.v = (seed.v * 1664525 + 1013904223) >>> 0;
  return seed.v / 0xffffffff;
}

function drawBranch(
  ctx: CanvasRenderingContext2D,
  seed: { v: number },
  x0: number,
  y0: number,
  angle: number,
  length: number,
  width: number,
  depth: number,
): void {
  if (depth <= 0 || length < 5) return;
  const steps = 4 + depth;
  const stepLen = length / steps;
  let x = x0;
  let y = y0;
  let a = angle;

  ctx.beginPath();
  ctx.moveTo(x, y);
  for (let i = 0; i < steps; i++) {
    a += (nextRand(seed) - 0.5) * 0.85;
    x += Math.cos(a) * stepLen;
    y += Math.sin(a) * stepLen;
    ctx.lineTo(x, y);
    if (depth > 1 && i > 0 && i < steps - 1 && nextRand(seed) < 0.55) {
      const sign = nextRand(seed) < 0.5 ? -1 : 1;
      drawBranch(ctx, seed, x, y, a + sign * (0.45 + nextRand(seed) * 0.55), length * 0.58, width * 0.65, depth - 1);
    }
  }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(44, 34, 28, 0.45)";
  ctx.lineWidth = width + 1.4;
  ctx.stroke();
  ctx.strokeStyle = "rgba(18, 13, 10, 0.92)";
  ctx.lineWidth = width;
  ctx.stroke();
}

function makeCrackTexture(level: CrackSeverity): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return null;

  const seed = { v: 0x2f6e2b1 ^ (level * 0x9e3779b1) };
  const roots = level === 1 ? 3 : level === 2 ? 6 : 10;
  for (let i = 0; i < roots; i++) {
    const cx = 20 + nextRand(seed) * 88;
    const cy = 20 + nextRand(seed) * 88;
    const ang = nextRand(seed) * Math.PI * 2;
    drawBranch(ctx, seed, cx, cy, ang, 24 + level * 14, 1.0 + level * 0.55, level === 1 ? 1 : 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Pooled instanced crack overlays rendered cleanly around damaged props and building parts. */
export class CrackOverlays {
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly textures: (THREE.CanvasTexture | null)[] = [];
  private readonly materials: THREE.MeshBasicMaterial[] = [];
  private readonly layers: THREE.InstancedMesh[] = [];
  private readonly entries = new Map<bigint, CrackEntry>();
  private dirty = false;

  constructor(private readonly parent: THREE.Object3D) {
    for (const lvl of [1, 2, 3] as const) {
      const tex = makeCrackTexture(lvl);
      this.textures.push(tex);
      const mat = new THREE.MeshBasicMaterial({
        ...(tex ? { map: tex } : { color: 0x16110e }),
        transparent: true,
        opacity: tex ? 0.85 : 0.14 + lvl * 0.08,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      this.materials.push(mat);
      const mesh = new THREE.InstancedMesh(this.geometry, mat, MAX_CRACK_OVERLAYS);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 3;
      mesh.name = `crack-overlays-l${lvl}`;
      this.layers.push(mesh);
      parent.add(mesh);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  layerCount(level: CrackSeverity): number {
    return this.layers[level - 1]!.count;
  }

  set(wid: bigint, t: TransformRow, body: BodyConfigRow | undefined, stage: number, totalStages: number): void {
    const level = crackSeverity(stage, totalStages);
    if (level === 0) {
      this.remove(wid);
      return;
    }
    const r = body && body.radius > 0 ? body.radius : 0.5;
    const hx = Math.max(0.15, (body && body.halfX > 0 ? body.halfX : r) * t.sx);
    const hy = Math.max(0.15, (body && body.halfY > 0 ? body.halfY : r) * t.sy);
    const hz = Math.max(0.15, (body && body.halfZ > 0 ? body.halfZ : r) * t.sz);

    if (!this.entries.has(wid) && this.entries.size >= MAX_CRACK_OVERLAYS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(wid, {
      px: t.px,
      py: t.py,
      pz: t.pz,
      qx: t.qx,
      qy: t.qy,
      qz: t.qz,
      qw: t.qw,
      sx: hx * 2.02,
      sy: hy * 2.01,
      sz: hz * 2.02,
      level,
    });
    this.dirty = true;
  }

  remove(wid: bigint): void {
    if (this.entries.delete(wid)) this.dirty = true;
  }

  prune(exists: (wid: bigint) => boolean): void {
    for (const wid of this.entries.keys()) {
      if (!exists(wid)) {
        this.entries.delete(wid);
        this.dirty = true;
      }
    }
  }

  sync(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const counts = [0, 0, 0];
    for (const e of this.entries.values()) {
      const idx = e.level - 1;
      const mesh = this.layers[idx]!;
      const slot = counts[idx]!;
      if (slot >= MAX_CRACK_OVERLAYS) continue;
      tmpMatrix.compose(tmpPos.set(e.px, e.py, e.pz), tmpQuat.set(e.qx, e.qy, e.qz, e.qw), tmpScale.set(e.sx, e.sy, e.sz));
      mesh.setMatrixAt(slot, tmpMatrix);
      counts[idx] = slot + 1;
    }
    for (let i = 0; i < this.layers.length; i++) {
      const mesh = this.layers[i]!;
      const n = counts[i]!;
      mesh.count = n;
      mesh.visible = n > 0;
      if (n > 0) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const mesh of this.layers) {
      this.parent.remove(mesh);
      mesh.dispose();
    }
    for (const mat of this.materials) mat.dispose();
    for (const tex of this.textures) tex?.dispose();
    this.geometry.dispose();
    this.entries.clear();
  }
}
