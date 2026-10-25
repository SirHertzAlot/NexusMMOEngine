/**
 * Telegraphs (roadmap M5, protocol 0x1e): the ground warnings the server
 * casts before a shaped attack lands. Each warning draws as a flat decal
 * (circle, cone or rectangle) whose fill sweeps out from the caster over
 * the warning time; when it lands or is cancelled it fades out. The server
 * decides who is hit — this is presentation only.
 *
 * Cheap by design: one shared unit quad, a fixed pool of meshes (each with
 * its own small ShaderMaterial for uniforms), no allocation per frame.
 */

import * as THREE from "three";
import type { TelegraphMessage } from "@mmo-engine/protocol";

/** Most warnings drawn at once; the oldest is reused past this. */
export const TELEGRAPH_POOL = 32;
/** Seconds a warning takes to fade after it lands / is cancelled. */
export const FADE_RESOLVED = 0.35;
export const FADE_CANCELLED = 0.2;
/** Lift above the ground (at the shape's centre) against z-fighting. */
const LIFT = 0.08;

const KIND = { circle: 0, cone: 1, rect: 2 } as const;

const VERT = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// vP is in unit shape space: circle/cone radius 1, rect [-1,1]² with +z forward.
const FRAG = /* glsl */ `
  uniform int uKind;
  uniform float uHalf;
  uniform float uFill;
  uniform float uAlpha;
  uniform vec3 uColor;
  varying vec2 vP;
  void main() {
    float d;
    float edge;
    if (uKind == 2) {
      d = (vP.y + 1.0) * 0.5;
      edge = max(smoothstep(0.94, 1.0, abs(vP.x)), smoothstep(0.96, 1.0, abs(vP.y)));
    } else {
      d = length(vP);
      if (d > 1.0) discard;
      edge = smoothstep(0.93, 1.0, d);
      if (uKind == 1) {
        float a = abs(atan(vP.x, vP.y));
        if (a > uHalf) discard;
        edge = max(edge, smoothstep(uHalf - 0.05, uHalf, a) * step(0.02, d));
      }
    }
    float filled = step(d, uFill);
    float front = (1.0 - smoothstep(0.0, 0.04, abs(d - uFill))) * step(uFill, 0.999);
    float a = uAlpha * clamp(0.15 + 0.35 * filled + 0.6 * edge + 0.5 * front, 0.0, 1.0);
    gl_FragColor = vec4(uColor, a);
  }
`;

interface Slot {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  /** Telegraph id, or -1 when free. */
  id: number;
  /** performance.now() seconds the warning started and lands. */
  start: number;
  hit: number;
  /** When the fade-out started (NaN: still warning) and how long it runs. */
  fadeAt: number;
  fadeFor: number;
}

export class Telegraphs {
  readonly group = new THREE.Group();
  private readonly geo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  private readonly slots: Slot[] = [];

  constructor(color = 0xef4444) {
    this.group.name = "telegraphs";
    for (let i = 0; i < TELEGRAPH_POOL; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uKind: { value: 0 },
          uHalf: { value: 0 },
          uFill: { value: 0 },
          uAlpha: { value: 0 },
          uColor: { value: new THREE.Color(color) },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 1;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.slots.push({ mesh, mat, id: -1, start: 0, hit: 0, fadeAt: NaN, fadeFor: 0 });
    }
  }

  /** Apply a 0x1e message. `heightAt` places the decal; `now` is seconds. */
  apply(m: TelegraphMessage, tickHz: number, heightAt: (x: number, z: number) => number | null, now = performance.now() / 1000): void {
    if (m.state !== "warned") {
      const s = this.slots.find((s) => s.id === m.id);
      if (s && Number.isNaN(s.fadeAt)) {
        s.fadeAt = now;
        s.fadeFor = m.state === "cancelled" ? FADE_CANCELLED : FADE_RESOLVED;
      }
      return;
    }
    const s = this.freeSlot();
    s.id = m.id;
    s.start = now;
    s.hit = now + (m.ticksUntilHit ?? 0) / (tickHz || 30);
    s.fadeAt = NaN;
    const sh = m.shape;
    const u = s.mat.uniforms;
    u.uKind.value = KIND[sh.kind];
    const y = (heightAt(sh.x, sh.z) ?? 0) + LIFT;
    const mesh = s.mesh;
    mesh.rotation.set(0, sh.kind === "circle" ? 0 : sh.yaw, 0);
    if (sh.kind === "circle") {
      mesh.position.set(sh.x, y, sh.z);
      mesh.scale.set(sh.r, 1, sh.r);
    } else if (sh.kind === "cone") {
      u.uHalf.value = sh.halfAngle;
      mesh.position.set(sh.x, y, sh.z);
      mesh.scale.set(sh.range, 1, sh.range);
    } else {
      const h = sh.length / 2;
      mesh.position.set(sh.x + Math.sin(sh.yaw) * h, y, sh.z + Math.cos(sh.yaw) * h);
      mesh.scale.set(sh.width / 2, 1, h);
    }
    mesh.visible = true;
    this.update(now);
  }

  /** Advance fills and fades; call once per frame. */
  update(now = performance.now() / 1000): void {
    for (const s of this.slots) {
      if (s.id < 0) continue;
      const u = s.mat.uniforms;
      const span = s.hit - s.start;
      u.uFill.value = span > 0 ? Math.min(1, (now - s.start) / span) : 1;
      let alpha = 1;
      if (!Number.isNaN(s.fadeAt)) {
        alpha = 1 - (now - s.fadeAt) / s.fadeFor;
        // Landed: show it full while it fades.
        u.uFill.value = 1;
      } else if (now > s.hit + 2) {
        // ponytail: the resolve message never came (lost, or the caster left our view) — drop it.
        alpha = 0;
      }
      if (alpha <= 0) this.release(s);
      else u.uAlpha.value = alpha;
    }
  }

  /** Warnings on screen (tests, debugging). */
  get active(): number {
    let n = 0;
    for (const s of this.slots) if (s.id >= 0) n++;
    return n;
  }

  /** Drop every warning (leaving a region or an instance). */
  clear(): void {
    for (const s of this.slots) if (s.id >= 0) this.release(s);
  }

  dispose(): void {
    this.geo.dispose();
    for (const s of this.slots) s.mat.dispose();
  }

  private release(s: Slot): void {
    s.id = -1;
    s.mesh.visible = false;
    s.mat.uniforms.uAlpha.value = 0;
  }

  private freeSlot(): Slot {
    let oldest = this.slots[0];
    for (const s of this.slots) {
      if (s.id < 0) return s;
      if (s.start < oldest.start) oldest = s;
    }
    return oldest;
  }
}
