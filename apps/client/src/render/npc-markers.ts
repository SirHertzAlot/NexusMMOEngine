/**
 * NpcMarkers (roadmap P1/U11): the quest givers in the world.
 *
 * Npcs aren't simulated entities: the server names them and where they
 * stand (the npcs message), and the client draws each as a robed figure
 * on the ground with its name over it and, when it has something for the
 * player, a floating marker: "!" a quest to take, "?" a quest to hand in.
 * The npc nearest the player within talk range is what the interact key
 * talks to.
 *
 * A handful of npcs at most, so plain meshes and one sprite each; label
 * textures are made once per npc and marker textures once per glyph.
 */

import * as THREE from "three";
import type { NpcView } from "@mmo-engine/protocol";

/** Talk prompt range (metres); a little inside the server's default talk range (6). */
export const NPC_TALK_RANGE = 5;
/** Name and marker heights over the ground, metres. */
const NAME_HEIGHT = 2.25;
const MARKER_HEIGHT = 2.9;
const NAME_TEXT = 0.42;
const MARKER_SIZE = 0.75;
/** Names and markers fade out between these distances from the camera. */
const FADE_FROM = 40;
const FADE_TO = 90;

const tmpEye = new THREE.Vector3();

/** The glyph and colour a marker shows, or null for none. */
export function markerGlyph(marker: NpcView["marker"]): { text: string; color: string } | null {
  if (marker === "offer") return { text: "!", color: "#facc15" };
  if (marker === "ready") return { text: "?", color: "#facc15" };
  return null;
}

/** The npc nearest (x, z) within `range` metres on the ground plane, or null. */
export function nearestNpc(npcs: readonly NpcView[], x: number, z: number, range: number): NpcView | null {
  let best: NpcView | null = null;
  let bestD = range * range;
  for (const n of npcs) {
    const d = (n.x - x) ** 2 + (n.z - z) ** 2;
    if (d <= bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

interface Figure {
  root: THREE.Group;
  name: THREE.Sprite;
  marker: THREE.Sprite;
  markerKey: string | null;
}

export class NpcMarkers {
  readonly group = new THREE.Group();
  private readonly figures = new Map<string, Figure>();
  private readonly glyphs = new Map<string, THREE.CanvasTexture>();
  private readonly robe = new THREE.MeshStandardMaterial({ color: 0x3f5a7a, roughness: 0.85 });
  private readonly skin = new THREE.MeshStandardMaterial({ color: 0xd9b38c, roughness: 0.7 });
  private readonly bodyGeo = new THREE.CylinderGeometry(0.28, 0.42, 1.5, 10);
  private readonly headGeo = new THREE.SphereGeometry(0.2, 12, 10);
  private nearestId: string | null = null;

  constructor() {
    this.group.name = "npc-markers";
  }

  /** The npc the interact key would talk to at the last sync, or null. */
  get nearest(): string | null {
    return this.nearestId;
  }

  /**
   * Reconcile with the npc list and place everything for this frame.
   * `heightAt` is the terrain's ground height (null: not loaded there yet,
   * the figure waits); `player` the player's position, or null.
   */
  sync(npcs: readonly NpcView[], heightAt: (x: number, z: number) => number | null, camera: THREE.Camera, player: THREE.Vector3 | null, nowMs: number): void {
    const seen = new Set<string>();
    const eye = camera.getWorldPosition(tmpEye);
    for (const n of npcs) {
      seen.add(n.id);
      const y = heightAt(n.x, n.z);
      let f = this.figures.get(n.id);
      if (!f) f = this.add(n);
      f.root.visible = y !== null;
      if (y === null) continue;
      f.root.position.set(n.x, y, n.z);
      if (player) f.root.rotation.y = Math.atan2(player.x - n.x, player.z - n.z);
      const glyph = markerGlyph(n.marker);
      const key = glyph ? glyph.text : null;
      if (key !== f.markerKey) {
        f.markerKey = key;
        if (glyph) f.marker.material.map = this.glyph(glyph.text, glyph.color);
        f.marker.material.needsUpdate = true;
      }
      const dist = eye.distanceTo(f.root.position);
      const fade = dist <= FADE_FROM ? 1 : Math.max(0, 1 - (dist - FADE_FROM) / (FADE_TO - FADE_FROM));
      f.name.material.opacity = fade;
      f.marker.visible = glyph !== null;
      f.marker.material.opacity = Math.max(fade, 0.6);
      f.marker.position.y = MARKER_HEIGHT + Math.sin(nowMs / 400) * 0.08;
    }
    for (const [id, f] of this.figures) if (!seen.has(id)) this.remove(id, f);
    this.nearestId = player ? (nearestNpc(npcs, player.x, player.z, NPC_TALK_RANGE)?.id ?? null) : null;
  }

  dispose(): void {
    for (const [id, f] of this.figures) this.remove(id, f);
    for (const t of this.glyphs.values()) t.dispose();
    this.glyphs.clear();
    this.robe.dispose();
    this.skin.dispose();
    this.bodyGeo.dispose();
    this.headGeo.dispose();
  }

  private add(n: NpcView): Figure {
    const root = new THREE.Group();
    root.name = `npc:${n.id}`;
    const body = new THREE.Mesh(this.bodyGeo, this.robe);
    body.position.y = 0.75;
    const head = new THREE.Mesh(this.headGeo, this.skin);
    head.position.y = 1.72;
    const { tex, width } = labelTexture(n.name, "#fde68a");
    const name = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    name.scale.set((width / 72) * NAME_TEXT, NAME_TEXT, 1);
    name.position.y = NAME_HEIGHT;
    name.renderOrder = 2;
    const marker = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
    marker.scale.set(MARKER_SIZE * 0.6, MARKER_SIZE, 1);
    marker.renderOrder = 2;
    marker.visible = false;
    root.add(body, head, name, marker);
    this.group.add(root);
    const f: Figure = { root, name, marker, markerKey: null };
    this.figures.set(n.id, f);
    return f;
  }

  private remove(id: string, f: Figure): void {
    this.group.remove(f.root);
    f.name.material.map?.dispose();
    f.name.material.dispose();
    f.marker.material.dispose();
    this.figures.delete(id);
  }

  private glyph(text: string, color: string): THREE.CanvasTexture {
    let t = this.glyphs.get(text);
    if (!t) {
      const canvas = document.createElement("canvas");
      canvas.width = 72;
      canvas.height = 120;
      const ctx = canvas.getContext("2d")!;
      ctx.font = "900 108px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 12;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.strokeText(text, 36, 64);
      ctx.fillStyle = color;
      ctx.fillText(text, 36, 64);
      t = new THREE.CanvasTexture(canvas);
      t.colorSpace = THREE.SRGBColorSpace;
      this.glyphs.set(text, t);
    }
    return t;
  }
}

/** An npc's name, outlined for any background. */
function labelTexture(text: string, color: string): { tex: THREE.CanvasTexture; width: number } {
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
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, 38);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, width: w };
}
