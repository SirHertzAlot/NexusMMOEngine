/**
 * DungeonEntrances (roadmap D4): where dungeon runs start, in the world.
 *
 * The region names each entrance and its radius (the dungeon entrances
 * message); the client draws a glowing ring on the ground at that radius,
 * a dark gate in the middle and the name over it. Standing inside a ring
 * is what lets the interact key ask for a run there.
 */

import * as THREE from "three";
import type { DungeonEntranceView } from "@mmo-engine/protocol";

const NAME_HEIGHT = 3.6;
const NAME_TEXT = 0.5;
const FADE_FROM = 50;
const FADE_TO = 120;

const tmpEye = new THREE.Vector3();

/** The entrance whose ring (x, z) stands in, nearest centre first, or null. */
export function entranceAt(entrances: readonly DungeonEntranceView[], x: number, z: number): DungeonEntranceView | null {
  let best: DungeonEntranceView | null = null;
  let bestD = Infinity;
  for (const e of entrances) {
    const d = (e.x - x) ** 2 + (e.z - z) ** 2;
    if (d <= e.radius * e.radius && d < bestD) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

interface Gate {
  root: THREE.Group;
  ring: THREE.Mesh;
  name: THREE.Sprite;
  radius: number;
}

export class DungeonEntrances {
  readonly group = new THREE.Group();
  private readonly gates = new Map<string, Gate>();
  private readonly ringMat = new THREE.MeshBasicMaterial({ color: 0xa78bfa, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  private readonly stoneMat = new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.95 });
  private readonly voidMat = new THREE.MeshBasicMaterial({ color: 0x0b0716 });
  private readonly pillarGeo = new THREE.BoxGeometry(0.6, 3, 0.6);
  private readonly lintelGeo = new THREE.BoxGeometry(3.2, 0.5, 0.7);
  private readonly voidGeo = new THREE.PlaneGeometry(2, 2.8);
  private nearestId: string | null = null;

  constructor() {
    this.group.name = "dungeon-entrances";
  }

  /** The entrance the player stands in at the last sync, or null. */
  get nearest(): string | null {
    return this.nearestId;
  }

  sync(entrances: readonly DungeonEntranceView[], heightAt: (x: number, z: number) => number | null, camera: THREE.Camera, player: THREE.Vector3 | null, nowMs: number): void {
    const seen = new Set<string>();
    const eye = camera.getWorldPosition(tmpEye);
    for (const e of entrances) {
      seen.add(e.id);
      let g = this.gates.get(e.id);
      if (!g || g.radius !== e.radius) {
        if (g) this.remove(e.id, g);
        g = this.add(e);
      }
      const y = heightAt(e.x, e.z);
      g.root.visible = y !== null;
      if (y === null) continue;
      g.root.position.set(e.x, y, e.z);
      (g.ring.material as THREE.MeshBasicMaterial).opacity = 0.4 + 0.2 * Math.sin(nowMs / 500);
      const dist = eye.distanceTo(g.root.position);
      g.name.material.opacity = dist <= FADE_FROM ? 1 : Math.max(0, 1 - (dist - FADE_FROM) / (FADE_TO - FADE_FROM));
    }
    for (const [id, g] of this.gates) if (!seen.has(id)) this.remove(id, g);
    this.nearestId = player ? (entranceAt(entrances, player.x, player.z)?.id ?? null) : null;
  }

  dispose(): void {
    for (const [id, g] of this.gates) this.remove(id, g);
    this.ringMat.dispose();
    this.stoneMat.dispose();
    this.voidMat.dispose();
    this.pillarGeo.dispose();
    this.lintelGeo.dispose();
    this.voidGeo.dispose();
  }

  private add(e: DungeonEntranceView): Gate {
    const root = new THREE.Group();
    root.name = `entrance:${e.id}`;
    const ringGeo = new THREE.RingGeometry(Math.max(0.5, e.radius - 0.35), e.radius, 64);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, this.ringMat.clone());
    ring.position.y = 0.06;
    const left = new THREE.Mesh(this.pillarGeo, this.stoneMat);
    left.position.set(-1.3, 1.5, 0);
    const right = new THREE.Mesh(this.pillarGeo, this.stoneMat);
    right.position.set(1.3, 1.5, 0);
    const lintel = new THREE.Mesh(this.lintelGeo, this.stoneMat);
    lintel.position.set(0, 3.1, 0);
    const dark = new THREE.Mesh(this.voidGeo, this.voidMat);
    dark.position.set(0, 1.4, 0);
    const back = dark.clone();
    back.rotation.y = Math.PI;
    const { tex, width } = labelTexture(e.name);
    const name = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    name.scale.set((width / 72) * NAME_TEXT, NAME_TEXT, 1);
    name.position.y = NAME_HEIGHT;
    name.renderOrder = 2;
    root.add(ring, left, right, lintel, dark, back, name);
    this.group.add(root);
    const g: Gate = { root, ring, name, radius: e.radius };
    this.gates.set(e.id, g);
    return g;
  }

  private remove(id: string, g: Gate): void {
    this.group.remove(g.root);
    g.ring.geometry.dispose();
    (g.ring.material as THREE.Material).dispose();
    g.name.material.map?.dispose();
    g.name.material.dispose();
    this.gates.delete(id);
  }
}

function labelTexture(text: string): { tex: THREE.CanvasTexture; width: number } {
  const font = "600 40px system-ui, sans-serif";
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = font;
  const w = Math.ceil(measure.measureText(text).width) + 36;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = 72;
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 7;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(text, w / 2, 38);
  ctx.fillStyle = "#c4b5fd";
  ctx.fillText(text, w / 2, 38);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, width: w };
}
