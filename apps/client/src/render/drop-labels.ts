/**
 * DropLabels (roadmap M3a): what lies on the ground, made easy to see.
 *
 * Every ground item the server named (the mirror's `drops`, protocol 0x15)
 * gets its name over it in its rank's colour, and a faint beam of light in
 * that colour so drops can be spotted from a distance. The item's model
 * itself is drawn by the instanced props like any scenery (its AssetRef).
 *
 * Draw calls: every beam is one instance of a single InstancedMesh (per-
 * instance colour); labels are sprites sharing one texture per distinct
 * name and colour. Per frame this only moves and fades what exists — no
 * allocation; sprites and textures are made when a drop first appears and
 * disposed when the last one using them goes.
 */

import * as THREE from "three";
import type { MirrorState } from "@mmo-engine/mirror";

export interface DropInfo {
  name: string;
  rank: string;
  color: string;
}

/** Most beams drawn at once (the nearest win when there are more). */
const MAX_BEAMS = 512;
/** Label height above the item, and text height (world units). */
const LABEL_HEIGHT = 0.55;
const LABEL_TEXT = 0.32;
/** Labels show fully within this range, fading out by LABEL_FADE. */
const LABEL_FULL = 14;
const LABEL_FADE = 32;
/** Beam size, metres. */
const BEAM_HEIGHT = 2.2;
const BEAM_RADIUS = 0.05;

interface Label {
  sprite: THREE.Sprite;
  key: string;
  /** The rank colour, parsed once. */
  color: THREE.Color;
}

const tmpMatrix = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3(1, 1, 1);
const hidden = new THREE.Matrix4().makeScale(0, 0, 0);

export class DropLabels {
  readonly group = new THREE.Group();
  private readonly beams: THREE.InstancedMesh;
  private readonly labels = new Map<bigint, Label>();
  private readonly textures = new Map<string, { tex: THREE.CanvasTexture; users: number; width: number }>();
  private nearestId: bigint | null = null;
  private nearestDist = Infinity;

  constructor() {
    this.group.name = "drop-labels";
    const geo = new THREE.CylinderGeometry(BEAM_RADIUS, BEAM_RADIUS * 0.4, BEAM_HEIGHT, 6, 1, true);
    geo.translate(0, BEAM_HEIGHT / 2, 0);
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.beams = new THREE.InstancedMesh(geo, mat, MAX_BEAMS);
    this.beams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beams.count = 0;
    this.beams.frustumCulled = false;
    this.beams.name = "drop-beams";
    this.group.add(this.beams);
  }

  /** The ground item nearest the player within `range` metres at the last sync, or null. */
  get nearest(): bigint | null {
    return this.nearestId;
  }

  /**
   * Reconcile with the mirror and place everything for this frame.
   * `player`: the player's position (null: not known yet); `camera` for
   * the label fade; `range`: how near counts as "can pick up".
   */
  sync(state: MirrorState, drops: ReadonlyMap<bigint, DropInfo>, camera: THREE.Camera, player: THREE.Vector3 | null, range: number): void {
    // Labels for drops that went away.
    for (const [wid, label] of this.labels) {
      if (!drops.has(wid) || !state.entities.has(wid)) this.removeLabel(wid, label);
    }
    camera.getWorldPosition(tmpPos);
    const eyeX = tmpPos.x;
    const eyeY = tmpPos.y;
    const eyeZ = tmpPos.z;
    this.nearestId = null;
    this.nearestDist = Infinity;
    let beam = 0;
    for (const [wid, info] of drops) {
      const t = state.entities.get(wid)?.transform;
      if (!t) continue;
      let label = this.labels.get(wid);
      if (!label) label = this.addLabel(wid, info);
      label.sprite.position.set(t.px, t.py + LABEL_HEIGHT, t.pz);
      const dx = t.px - eyeX;
      const dy = t.py - eyeY;
      const dz = t.pz - eyeZ;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const mat = label.sprite.material;
      mat.opacity = dist <= LABEL_FULL ? 1 : Math.max(0, 1 - (dist - LABEL_FULL) / (LABEL_FADE - LABEL_FULL));
      label.sprite.visible = mat.opacity > 0;
      if (player) {
        const px = t.px - player.x;
        const pz = t.pz - player.z;
        const d = Math.sqrt(px * px + pz * pz);
        if (d <= range && d < this.nearestDist && Math.abs(t.py - player.y) < 3) {
          this.nearestDist = d;
          this.nearestId = wid;
        }
      }
      if (beam < MAX_BEAMS) {
        tmpPos.set(t.px, t.py, t.pz);
        tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
        this.beams.setMatrixAt(beam, tmpMatrix);
        this.beams.setColorAt(beam, label.color);
        beam++;
      }
    }
    // The nearest drop's label stands out.
    for (const [wid, label] of this.labels) {
      const s = wid === this.nearestId ? 1.25 : 1;
      const w = this.textures.get(label.key)?.width ?? 72;
      label.sprite.scale.set((w / 72) * LABEL_TEXT * s, LABEL_TEXT * s, 1);
    }
    for (let i = beam; i < this.beams.count; i++) this.beams.setMatrixAt(i, hidden);
    this.beams.count = beam;
    this.beams.instanceMatrix.needsUpdate = true;
    if (this.beams.instanceColor) this.beams.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    for (const [wid, label] of this.labels) this.removeLabel(wid, label);
    this.beams.geometry.dispose();
    (this.beams.material as THREE.Material).dispose();
    this.beams.dispose();
  }

  private addLabel(wid: bigint, info: DropInfo): Label {
    const key = `${info.color}|${info.name}`;
    let entry = this.textures.get(key);
    if (!entry) {
      const { tex, width } = labelTexture(info.name, info.color);
      entry = { tex, users: 0, width };
      this.textures.set(key, entry);
    }
    entry.users++;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: entry.tex, transparent: true, depthWrite: false }));
    sprite.renderOrder = 2;
    this.group.add(sprite);
    const label = { sprite, key, color: new THREE.Color(info.color) };
    this.labels.set(wid, label);
    return label;
  }

  private removeLabel(wid: bigint, label: Label): void {
    this.group.remove(label.sprite);
    label.sprite.material.dispose();
    this.labels.delete(wid);
    const entry = this.textures.get(label.key);
    if (entry && --entry.users <= 0) {
      entry.tex.dispose();
      this.textures.delete(label.key);
    }
  }
}

/** A name in its rank's colour, outlined for any background. */
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
  tex.needsUpdate = true;
  return { tex, width: w };
}
