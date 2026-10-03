/**
 * DungeonScene (ROADMAP E8) — a baked dungeon in 3D, the instanced look of
 * Dungeon Forge: one box per floor cell (tinted by its room's role), a
 * taller one per wall cell, spheres for spawn points (by tier), small
 * blocks for props, and glowing torches. Plain three.js, driven by the
 * panel (dungeon-view.tsx) with view-models from inspectors/dungeon-view.ts:
 * it draws and picks, and holds no edit state.
 *
 * One grid cell is one world unit: x across, z down the grid (the grid's y).
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CELL, type DungeonView, type RoomType } from "../inspectors/dungeon-view.js";

const ROLE_COLOR: Record<RoomType, number> = {
  entrance: 0x34d399,
  combat: 0x64748b,
  elite: 0xf59e0b,
  treasure: 0xfacc15,
  shrine: 0xa78bfa,
  boss: 0xef4444,
};
const CORRIDOR = 0x3f3f46;
const POOL = 0x0ea5e9;
const WALL = 0x27272a;
const TIER_COLOR = [0, 0x86efac, 0xfbbf24, 0xf87171];
const PROP_COLOR: Record<string, number> = { p: 0x94a3b8, d: 0xc4b5fd, a: 0x22d3ee };
const SELECTED = new THREE.Color(0xffffff);

export type Pick = { kind: "room"; id: number } | { kind: "spawn"; index: number } | { kind: "prop"; key: string } | null;

export class DungeonScene {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  private readonly controls: OrbitControls;
  private readonly root = new THREE.Group();
  private floors: THREE.InstancedMesh | null = null;
  private spawns: THREE.InstancedMesh | null = null;
  private props: THREE.InstancedMesh | null = null;
  private view: DungeonView | null = null;
  private selected: Pick = null;
  private frame = 0;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.1);

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x0b1020);
    this.scene.add(new THREE.HemisphereLight(0xdbeafe, 0x1f2937, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(-40, 80, 30);
    this.scene.add(sun, this.root);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    const loop = (): void => {
      this.frame = requestAnimationFrame(loop);
      this.resize();
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  /** Orbit the camera with the mouse (off while dragging a prop). */
  setOrbit(on: boolean): void {
    this.controls.enabled = on;
  }

  private resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  private clear(): void {
    for (const o of [...this.root.children]) {
      this.root.remove(o);
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x?.dispose());
    }
    this.floors = this.spawns = this.props = null;
  }

  /** Draw a dungeon; `refit` points the camera at it (a new dungeon, not an edit). */
  show(view: DungeonView, selected: Pick, refit: boolean): void {
    const layoutChanged = this.view?.id !== view.id;
    this.view = view;
    this.selected = selected;
    if (layoutChanged) this.buildStatic(view);
    this.buildDynamic(view);
    if (refit || layoutChanged) {
      const cx = view.width / 2;
      const cz = view.height / 2;
      const r = Math.max(view.width, view.height);
      this.controls.target.set(cx, 0, cz);
      this.camera.position.set(cx - r * 0.35, r * 0.75, cz + r * 0.7);
      this.camera.lookAt(cx, 0, cz);
    }
  }

  /** Floors and walls (rebuilt per dungeon; tints follow edits). */
  private buildStatic(view: DungeonView): void {
    this.clear();
    const cells = view.width * view.height;
    let floors = 0;
    let walls = 0;
    for (let i = 0; i < cells; i++) {
      if (view.grid[i] === CELL.floor || view.grid[i] === CELL.pool) floors++;
      else if (view.grid[i] === CELL.wall) walls++;
    }
    const m = new THREE.Matrix4();
    const floorMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.2, 1), new THREE.MeshStandardMaterial({ roughness: 0.9 }), floors);
    const wallMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial({ color: WALL, roughness: 1 }), walls);
    let f = 0;
    let w = 0;
    for (let y = 0; y < view.height; y++) {
      for (let x = 0; x < view.width; x++) {
        const c = view.grid[y * view.width + x];
        if (c === CELL.floor || c === CELL.pool) {
          m.makeTranslation(x + 0.5, c === CELL.pool ? -0.15 : 0, y + 0.5);
          floorMesh.setMatrixAt(f++, m);
        } else if (c === CELL.wall) {
          m.makeTranslation(x + 0.5, 1, y + 0.5);
          wallMesh.setMatrixAt(w++, m);
        }
      }
    }
    floorMesh.userData.kind = "floor";
    this.floors = floorMesh;
    this.root.add(floorMesh, wallMesh);
    // Torches: small glowing blocks on their walls.
    const torch = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 0.4, 0.25), new THREE.MeshBasicMaterial({ color: 0xffa94d }), view.torches.length);
    view.torches.forEach((t, i) => {
      m.makeTranslation(t.x + 0.5 + t.dx * 0.55, 1.4, t.y + 0.5 + t.dy * 0.55);
      torch.setMatrixAt(i, m);
    });
    this.root.add(torch);
  }

  /** Tints, spawns and props: what edits change. */
  private buildDynamic(view: DungeonView): void {
    if (this.floors) {
      const type = new Map(view.rooms.map((r) => [r.id, r.type]));
      const col = new THREE.Color();
      let f = 0;
      for (let i = 0; i < view.grid.length; i++) {
        const c = view.grid[i];
        if (c !== CELL.floor && c !== CELL.pool) continue;
        const room = view.roomId[i];
        const t = room >= 0 ? type.get(room) : undefined;
        col.setHex(c === CELL.pool ? POOL : t ? ROLE_COLOR[t] : CORRIDOR);
        if (this.selected?.kind === "room" && room === this.selected.id) col.lerp(SELECTED, 0.45);
        this.floors.setColorAt(f++, col);
      }
      if (this.floors.instanceColor) this.floors.instanceColor.needsUpdate = true;
    }
    for (const mesh of [this.spawns, this.props]) {
      if (!mesh) continue;
      this.root.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    const spawns = new THREE.InstancedMesh(new THREE.SphereGeometry(0.4, 12, 8), new THREE.MeshStandardMaterial({ roughness: 0.4 }), Math.max(1, view.spawns.length));
    spawns.count = view.spawns.length;
    view.spawns.forEach((s, i) => {
      const sel = this.selected?.kind === "spawn" && this.selected.index === i;
      const scale = sel ? 1.6 : s.pinned ? 1.25 : 1;
      m.makeScale(scale, scale, scale).setPosition(s.x + 0.5, 0.6, s.y + 0.5);
      spawns.setMatrixAt(i, m);
      col.setHex(TIER_COLOR[s.tier] ?? 0xffffff);
      if (sel) col.lerp(SELECTED, 0.5);
      spawns.setColorAt(i, col);
    });
    spawns.userData.kind = "spawn";
    const props = new THREE.InstancedMesh(new THREE.BoxGeometry(0.45, 0.6, 0.45), new THREE.MeshStandardMaterial({ roughness: 0.7 }), Math.max(1, view.props.length));
    props.count = view.props.length;
    view.props.forEach((p, i) => {
      const sel = this.selected?.kind === "prop" && this.selected.key === p.key;
      const s = sel ? 1.5 : 1;
      m.makeRotationY(p.rot).scale(new THREE.Vector3(s, s, s)).setPosition(p.x, 0.4, p.y);
      props.setMatrixAt(i, m);
      col.setHex(PROP_COLOR[p.key[0]] ?? 0xffffff);
      if (p.edited) col.lerp(new THREE.Color(0x22d3ee), 0.5);
      if (sel) col.lerp(SELECTED, 0.6);
      props.setColorAt(i, col);
    });
    props.userData.kind = "prop";
    this.spawns = spawns;
    this.props = props;
    this.root.add(spawns, props);
  }

  private ray(clientX: number, clientY: number): void {
    const r = this.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
  }

  /** What is under the pointer: a spawn or prop first, then the room of the floor cell. */
  pick(clientX: number, clientY: number): Pick {
    const v = this.view;
    if (!v) return null;
    this.ray(clientX, clientY);
    const targets = [this.spawns, this.props, this.floors].filter((x): x is THREE.InstancedMesh => x !== null);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const kind = hit.object.userData.kind as string;
    if (kind === "spawn") return { kind: "spawn", index: hit.instanceId };
    if (kind === "prop") return { kind: "prop", key: v.props[hit.instanceId].key };
    const x = Math.floor(hit.point.x);
    const z = Math.floor(hit.point.z);
    const room = x >= 0 && z >= 0 && x < v.width && z < v.height ? v.roomId[z * v.width + x] : -1;
    return room >= 0 ? { kind: "room", id: room } : null;
  }

  /** The grid point under the pointer on the floor plane (for dragging a prop). */
  groundAt(clientX: number, clientY: number): { x: number; y: number } | null {
    this.ray(clientX, clientY);
    const p = this.raycaster.ray.intersectPlane(this.ground, new THREE.Vector3());
    return p ? { x: p.x, y: p.z } : null;
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.controls.dispose();
    this.clear();
    this.renderer.dispose();
  }
}
