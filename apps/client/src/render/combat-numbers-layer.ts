/**
 * Draws CombatNumbers floaters on a 2D canvas over the world (roadmap CF2):
 * each floater is anchored over its target's head, projected to the screen,
 * and animated in screen pixels. One canvas, no DOM nodes per number, no
 * allocation per frame (one reused vector).
 */

import * as THREE from "three";
import type { CombatNumbers } from "./combat-numbers.js";

/** World-space height above a body's origin where numbers start, metres. */
const HEAD = 2.1;
/** Others' numbers are not drawn beyond this range, metres (the player's own always are). */
const FAR = 70;
/** Base font size, px, before the floater's scale. */
const BASE_PX = 20;

const v = new THREE.Vector3();

/** `anchor` writes the target's world position into `out`; false when it is gone. */
export function drawNumbers(
  canvas: HTMLCanvasElement,
  numbers: CombatNumbers,
  camera: THREE.Camera,
  anchor: (wid: bigint, out: THREE.Vector3) => boolean,
): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (numbers.count === 0) return;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  for (const f of numbers.pool) {
    if (!f.live || !anchor(f.target, v)) continue;
    v.y += HEAD;
    if (!f.mine && v.distanceTo(camera.position) > FAR) continue;
    v.project(camera);
    if (v.z > 1) continue;
    const px = ((v.x * 0.5 + 0.5) * w) + f.x * dpr;
    const py = ((-v.y * 0.5 + 0.5) * h) + f.y * dpr;
    const size = BASE_PX * f.s * dpr;
    ctx.save();
    ctx.translate(px, py);
    if (f.rot) ctx.rotate(f.rot);
    ctx.globalAlpha = f.alpha;
    ctx.font = `800 ${size}px system-ui, sans-serif`;
    ctx.lineWidth = Math.max(2, size * 0.14);
    ctx.strokeStyle = "rgba(20,12,8,0.9)";
    ctx.strokeText(f.text, 0, 0);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, 0, 0);
    ctx.restore();
  }
}
