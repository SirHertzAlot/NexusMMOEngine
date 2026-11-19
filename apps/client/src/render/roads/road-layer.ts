/**
 * Paved streets as terrain-draped surfaces (roadmap SG11). The server spawns each street leg as a flat walk-through
 * slab (SG10); drawn as a box it floats off a slope and buries on the other side. This layer takes those slabs and
 * drapes each over the terrain the client is standing on (`legRibbon` + `roadStrip`), merged into one mesh: one draw
 * call however many streets there are. The terrain streams in, so a leg is draped again once the ground under it has
 * loaded; once every leg is draped nothing is rebuilt until a street comes or goes.
 */

import * as THREE from "three";
import { legRibbon, roadStrip, type GroundFn, type RoadLeg } from "./road-mesh.js";

/** A rebuild waits at least this long after the last one, ms: a ring of streets arrives in many frames. */
const REBUILD_MS = 250;
/** Most vertices in the merged mesh (the nearest streets are what matter; this is only a ceiling). */
const MAX_VERTICES = 120_000;

const SURFACE = "#7b7064";

interface Leg {
  leg: RoadLeg;
  draped: boolean;
}

export class RoadLayer {
  readonly group = new THREE.Group();
  private readonly legs = new Map<bigint, Leg>();
  private readonly mesh: THREE.Mesh;
  private dirty = false;
  private lastBuild = 0;

  constructor() {
    this.group.name = "roads";
    const mat = new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    this.mesh.name = "paved-streets";
    this.mesh.frustumCulled = false; // one mesh over the whole ring; its bounds are not worth keeping current
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    this.group.add(this.mesh);
  }

  get count(): number {
    return this.legs.size;
  }

  /** A street leg's slab, from its Transform: its pose and (the server put them in the scale) its size. */
  set(wid: bigint, t: { px: number; py: number; pz: number; qy: number; qw: number; sx: number; sy: number; sz: number }): void {
    const leg: RoadLeg = { x: t.px, y: t.py - t.sy / 2, z: t.pz, yaw: 2 * Math.atan2(t.qy, t.qw), width: t.sx, length: t.sz, thickness: t.sy };
    const old = this.legs.get(wid);
    if (old && old.leg.x === leg.x && old.leg.y === leg.y && old.leg.z === leg.z && old.leg.yaw === leg.yaw && old.leg.width === leg.width && old.leg.length === leg.length) return;
    this.legs.set(wid, { leg, draped: false });
    this.dirty = true;
  }

  remove(wid: bigint): void {
    if (this.legs.delete(wid)) this.dirty = true;
  }

  wireIds(): IterableIterator<bigint> {
    return this.legs.keys();
  }

  /** Re-drape what the terrain now covers, and rebuild the mesh when anything changed (at most every REBUILD_MS). */
  update(ground: GroundFn, now: number): void {
    // Legs not yet draped: did their ground load since the last look?
    if (!this.dirty) {
      for (const l of this.legs.values()) {
        if (l.draped) continue;
        if (ground(l.leg.x, l.leg.z) !== null) {
          this.dirty = true;
          break;
        }
      }
    }
    if (!this.dirty || now - this.lastBuild < REBUILD_MS) return;
    this.lastBuild = now;
    this.dirty = false;
    const parts: { positions: Float32Array; indices: Uint32Array }[] = [];
    let verts = 0;
    for (const l of this.legs.values()) {
      const r = legRibbon(l.leg, ground);
      l.draped = r.draped;
      const strip = roadStrip(r);
      if (strip.indices.length === 0 || verts + strip.positions.length / 3 > MAX_VERTICES) continue;
      verts += strip.positions.length / 3;
      parts.push(strip);
    }
    const positions = new Float32Array(verts * 3);
    const indices = new Uint32Array(parts.reduce((n, p) => n + p.indices.length, 0));
    let vo = 0;
    let io = 0;
    for (const p of parts) {
      const base = vo / 3;
      positions.set(p.positions, vo);
      vo += p.positions.length;
      for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i]! + base;
      io += p.indices.length;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    this.mesh.visible = indices.length > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
