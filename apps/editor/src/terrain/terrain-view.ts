/**
 * TerrainView — the Terrain panel's three.js viewport.
 *
 * Draws the world heightmap as one mesh per chunk, built exactly like the
 * game client's terrain (PlaneGeometry with 15x15 segments, vertex v <->
 * heights[v], sample i at local i*16/15), so what you sculpt is what
 * players stand on. Brush dabs edit the shared HeightGrid; the view only
 * redraws the chunks a dab touched.
 *
 * Controls: left-drag sculpts (reported through onDab), right-drag
 * orbits, middle-drag pans, wheel zooms.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { chunkKey, HeightGrid, TILE_SAMPLES } from "@mmo-engine/protocol";

/** Low ground green -> mid earth -> high rock, by normalized height. */
const LOW = new THREE.Color(0x3d6b35);
const MID = new THREE.Color(0x8c7a4a);
const HIGH = new THREE.Color(0xd4d4d4);
const tmpColor = new THREE.Color();

export function heightColor(h: number, min: number, max: number, out: THREE.Color): THREE.Color {
  const t = max > min ? Math.min(1, Math.max(0, (h - min) / (max - min))) : 0.5;
  return t < 0.5 ? out.copy(LOW).lerp(MID, t * 2) : out.copy(MID).lerp(HIGH, (t - 0.5) * 2);
}

/**
 * One chunk's mesh geometry, identical in layout to the client's terrain
 * mesh: vertex v = sample (v % 16, floor(v / 16)), local position
 * (i, j) * size/15 relative to the chunk's corner.
 */
export function buildChunkGeometry(size: number): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(size, size, TILE_SAMPLES - 1, TILE_SAMPLES - 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(TILE_SAMPLES * TILE_SAMPLES * 3), 3),
  );
  return geometry;
}

/** Write a tile's heights (and height colors) into a chunk geometry. */
export function writeChunkGeometry(
  geometry: THREE.BufferGeometry,
  heights: Float32Array,
  range: { min: number; max: number },
): void {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const col = geometry.attributes.color as THREE.BufferAttribute;
  for (let v = 0; v < TILE_SAMPLES * TILE_SAMPLES; v++) {
    pos.setY(v, heights[v]);
    heightColor(heights[v], range.min, range.max, tmpColor);
    col.setXYZ(v, tmpColor.r, tmpColor.g, tmpColor.b);
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
}

export interface TerrainViewCallbacks {
  /** A sculpt dab at world (x, z); dt = seconds since the previous dab. */
  onDab(x: number, z: number, dt: number, first: boolean): void;
}

export class TerrainView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly chunks = new Map<string, THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>>();
  private readonly material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });
  private readonly cursor: THREE.Mesh;
  private props: THREE.InstancedMesh | null = null;
  private grid: HeightGrid | null = null;
  private size = 16;
  private range = { min: 0, max: 1 };
  private sculpting = false;
  private lastDabAt = 0;
  private pendingHit: THREE.Vector3 | null = null;
  private readonly resizeObserver: ResizeObserver;
  private readonly cleanup: Array<() => void> = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: TerrainViewCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x0b1020);
    this.scene.add(new THREE.HemisphereLight(0xbdd4ff, 0x2a2118, 0.9));
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
    sun.position.set(30, 60, 20);
    this.scene.add(sun);

    this.cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.94, 1, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x66eeff, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;
    this.scene.add(this.cursor);

    this.controls = new OrbitControls(this.camera, canvas);
    // Left button is the brush; orbit/pan live on right/middle.
    this.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.controls.enableDamping = true;

    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ): void => {
      canvas.addEventListener(type, fn);
      this.cleanup.push(() => canvas.removeEventListener(type, fn));
    };
    on("contextmenu", (e) => e.preventDefault());
    on("pointerdown", (e) => {
      if (e.button !== 0) return;
      const hit = this.pick(e);
      if (!hit) return;
      canvas.setPointerCapture(e.pointerId);
      this.sculpting = true;
      this.lastDabAt = performance.now();
      this.callbacks.onDab(hit.x, hit.z, 1 / 60, true);
    });
    on("pointermove", (e) => {
      const hit = this.pick(e);
      this.placeCursor(hit);
      if (this.sculpting && hit) this.pendingHit = hit;
    });
    on("pointerup", (e) => {
      if (e.button !== 0) return;
      this.sculpting = false;
      this.pendingHit = null;
    });
    on("pointerleave", () => this.placeCursor(null));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    this.renderer.setAnimationLoop(() => {
      // Continuous sculpting while held: at most one dab per frame, scaled
      // by elapsed time so the brush feels the same at any frame rate.
      if (this.sculpting && this.pendingHit) {
        const now = performance.now();
        const dt = Math.min(0.1, (now - this.lastDabAt) / 1000);
        this.lastDabAt = now;
        this.callbacks.onDab(this.pendingHit.x, this.pendingHit.z, dt, false);
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  /** Show a world: builds one mesh per chunk and frames the camera. */
  setWorld(grid: HeightGrid, props: ReadonlyArray<readonly [number, number, number]>, chunkWorldSize: number): void {
    this.grid = grid;
    this.size = chunkWorldSize;
    for (const mesh of this.chunks.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunks.clear();
    this.range = heightRange(grid);
    for (const [cx, cz] of grid.chunkCoords()) {
      const mesh = new THREE.Mesh(buildChunkGeometry(chunkWorldSize), this.material);
      mesh.position.set(cx * chunkWorldSize + chunkWorldSize / 2, 0, cz * chunkWorldSize + chunkWorldSize / 2);
      writeChunkGeometry(mesh.geometry, grid.tile(cx, cz).heights, this.range);
      this.chunks.set(chunkKey(cx, cz), mesh);
      this.scene.add(mesh);
    }
    this.setProps(props);
    this.frame();
  }

  /** Redraw chunks after the grid changed under them. */
  updateChunks(keys: Iterable<string>): void {
    if (!this.grid) return;
    for (const key of keys) {
      const mesh = this.chunks.get(key);
      if (!mesh) continue;
      const [cx, cz] = key.split(",").map(Number);
      writeChunkGeometry(mesh.geometry, this.grid.tile(cx, cz).heights, this.range);
    }
  }

  setBrushRadius(radius: number): void {
    this.cursor.scale.setScalar(radius);
  }

  setWireframe(on: boolean): void {
    this.material.wireframe = on;
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    for (const fn of this.cleanup) fn();
    this.controls.dispose();
    for (const mesh of this.chunks.values()) mesh.geometry.dispose();
    this.chunks.clear();
    this.material.dispose();
    this.cursor.geometry.dispose();
    (this.cursor.material as THREE.Material).dispose();
    this.setProps([]);
    this.renderer.dispose();
  }

  private setProps(props: ReadonlyArray<readonly [number, number, number]>): void {
    if (this.props) {
      this.scene.remove(this.props);
      this.props.geometry.dispose();
      (this.props.material as THREE.Material).dispose();
      this.props = null;
    }
    if (props.length === 0) return;
    // Read-only markers for what stands on the terrain (trees, rocks…):
    // saving re-seats them onto the edited ground.
    const mesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.35, 1.2, 6).translate(0, 0.6, 0),
      new THREE.MeshStandardMaterial({ color: 0x1f5130, roughness: 0.8 }),
      props.length,
    );
    const m = new THREE.Matrix4();
    props.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
    mesh.instanceMatrix.needsUpdate = true;
    this.props = mesh;
    this.scene.add(mesh);
  }

  private pick(e: PointerEvent): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects([...this.chunks.values()], false);
    return hits.length > 0 ? hits[0].point.clone() : null;
  }

  private placeCursor(hit: THREE.Vector3 | null): void {
    this.cursor.visible = hit !== null;
    if (hit) this.cursor.position.set(hit.x, hit.y + 0.05, hit.z);
  }

  private frame(): void {
    const coords = this.grid?.chunkCoords() ?? [];
    if (coords.length === 0) return;
    const xs = coords.map(([cx]) => cx);
    const zs = coords.map(([, cz]) => cz);
    const cx = ((Math.min(...xs) + Math.max(...xs) + 1) / 2) * this.size;
    const cz = ((Math.min(...zs) + Math.max(...zs) + 1) / 2) * this.size;
    const span = (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) + 1) * this.size;
    this.controls.target.set(cx, 0, cz);
    this.camera.position.set(cx - span * 0.6, span * 0.8, cz - span * 0.6);
    this.controls.update();
  }

  private resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

function heightRange(grid: HeightGrid): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of grid.heights) {
    if (Number.isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? { min, max } : { min: 0, max: 1 };
}
