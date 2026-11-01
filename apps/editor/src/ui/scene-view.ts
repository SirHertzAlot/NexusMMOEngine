/**
 * SceneView - the Scenes workspace's three.js viewport (roadmap EA5).
 *
 * Draws the open scene's nodes (a marker each, at the node's scene-space
 * transform) over the world terrain, with the same chunk meshes the
 * Terrain panel and the client use. Picking, the translate / rotate / scale
 * gizmo and drops from the content browser are reported through
 * `handlers`; the view never edits the document itself, so every change
 * goes through the scene command stack (History) in the panel.
 *
 * Heights: a node's y is an offset above the ground at its x/z (the server
 * adds the ground height when it spawns the node), so the view draws a node
 * at ground + y and, with terrain snapping on, keeps that offset at 0.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { worldNodes, type LiveTransform, type SceneDoc, type Vec3 } from "@mmo-engine/scene";
import { buildChunkGeometry, writeChunkGeometry } from "../terrain/terrain-view.js";
import { makeHeightSampler, markerFor, type HeightTile } from "../viewport-model.js";
import { FLY_BOOST, FLY_KEYS, FLY_SPEED, flyAxes } from "./scene-camera.js";

export type GizmoMode = "translate" | "rotate" | "scale";

export interface SceneViewHandlers {
  /** A click picked a node (or empty space: null). */
  onSelect(id: string | null): void;
  /** A gizmo drag finished: the node's new scene-space transform. */
  onTransform(id: string, t: LiveTransform): void;
  /** A content-browser item was dropped on the ground at `position`. */
  onPlace(prefab: string, position: Vec3): void;
  /** The orbit camera moved: ground (x, z) it looks at. */
  onCameraGround?(pos: { x: number; z: number }): void;
  /** Free-fly turned on or off (Escape turns it off from the canvas). */
  onFly?(on: boolean): void;
}

const DEG = 180 / Math.PI;

function markerGeometry(shape: "box" | "cone" | "octahedron"): THREE.BufferGeometry {
  // All unit-sized with their base on y = 0, so scale reads as size.
  if (shape === "cone") return new THREE.ConeGeometry(0.5, 1.4, 16).translate(0, 0.7, 0);
  if (shape === "octahedron") return new THREE.OctahedronGeometry(0.4).translate(0, 0.4, 0);
  return new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
}

export class SceneView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);
  private readonly orbit: OrbitControls;
  private readonly gizmo: TransformControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly grid = new THREE.GridHelper(200, 100, 0x445066, 0x2a3040);
  private gizmosOn = true;
  private wireframe = false;
  private readonly nodes = new THREE.Group();
  private readonly terrain = new THREE.Group();
  private readonly ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  private readonly objects = new Map<string, THREE.Object3D>();
  private heightAt: (x: number, z: number) => number | null = () => null;
  private snapTerrain = true;
  private selected: string | null = null;
  private last: [SceneDoc, string | null, ReadonlySet<string>] | null = null;
  private mode: GizmoMode = "translate";
  /** Ground height under the dragged object at the last change (to keep its offset). */
  private lastGround = 0;
  private frameId = 0;
  private readonly observer: ResizeObserver;
  private readonly cleanup: Array<() => void> = [];
  /** Free-fly camera: WASD, Q/E, Shift; the orbit controls are off meanwhile. */
  private flying = false;
  private readonly keys = new Set<string>();
  private lastFrame = 0;
  /** Test hook: the last frame's draw-call count. */
  drawCalls = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly handlers: SceneViewHandlers,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x0b1020);
    this.scene.add(new THREE.HemisphereLight(0xbdd4ff, 0x2a2118, 0.9));
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
    sun.position.set(30, 60, 20);
    this.scene.add(sun);
    this.grid.position.y = -0.02;
    this.scene.add(this.grid, this.terrain, this.nodes, this.ground);

    this.camera.position.set(28, 22, 28);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.enableDamping = false;
    this.orbit.target.set(0, 0, 0);
    // Publish the ground point the camera looks at (Play menu "Start from
    // camera position"). Fires on orbit changes; the initial view publishes
    // once below.
    this.orbit.addEventListener("change", () => {
      this.handlers.onCameraGround?.({ x: this.orbit.target.x, z: this.orbit.target.z });
    });

    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSize(0.8);
    this.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener("dragging-changed", (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      this.orbit.enabled = !dragging;
      const id = this.selected;
      const obj = id ? this.objects.get(id) : undefined;
      if (dragging && obj) this.lastGround = this.heightAt(obj.position.x, obj.position.z) ?? 0;
      if (!dragging && id && obj) this.commit(id, obj);
    });
    this.gizmo.addEventListener("objectChange", () => {
      const obj = this.selected ? this.objects.get(this.selected) : undefined;
      if (obj) this.followGround(obj);
    });

    const down = { x: 0, y: 0, onGizmo: false };
    const onDown = (e: PointerEvent): void => {
      down.x = e.clientX;
      down.y = e.clientY;
      down.onGizmo = this.gizmo.axis !== null;
    };
    const onUp = (e: PointerEvent): void => {
      if (e.button !== 0 || down.onGizmo || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      this.handlers.onSelect(this.pick(e));
    };
    const onDragOver = (e: DragEvent): void => e.preventDefault();
    const onDrop = (e: DragEvent): void => {
      e.preventDefault();
      const id = e.dataTransfer?.getData("text/plain") ?? "";
      if (!id.startsWith("mmo-placeable:")) return;
      const p = this.groundPoint(e);
      if (p) this.handlers.onPlace(id.slice("mmo-placeable:".length), [round(p.x), 0, round(p.z)]);
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("dragover", onDragOver);
    canvas.addEventListener("drop", onDrop);
    this.cleanup.push(
      () => canvas.removeEventListener("pointerdown", onDown),
      () => canvas.removeEventListener("pointerup", onUp),
      () => canvas.removeEventListener("dragover", onDragOver),
      () => canvas.removeEventListener("drop", onDrop),
    );

    // Fly keys are read from the window so they work with the canvas focused
    // or not; typing in an input never moves the camera.
    const typing = (e: KeyboardEvent): boolean => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!this.flying || typing(e)) return;
      if (e.key === "Escape") {
        this.setFly(false);
        this.handlers.onFly?.(false);
        return;
      }
      const k = e.key.toLowerCase();
      if (!FLY_KEYS.has(k) && k !== "shift") return;
      e.preventDefault();
      this.keys.add(k);
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      this.keys.delete(e.key.toLowerCase());
    };
    const onBlur = (): void => this.keys.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    this.cleanup.push(
      () => window.removeEventListener("keydown", onKeyDown),
      () => window.removeEventListener("keyup", onKeyUp),
      () => window.removeEventListener("blur", onBlur),
    );

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement ?? canvas);
    this.resize();
    const loop = (): void => {
      this.frameId = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = this.lastFrame === 0 ? 0 : Math.min(0.1, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      if (this.flying) this.fly(dt);
      this.renderer.render(this.scene, this.camera);
      this.drawCalls = this.renderer.info.render.calls;
    };
    loop();
  }

  private resize(): void {
    const box = (this.canvas.parentElement ?? this.canvas).getBoundingClientRect();
    const w = Math.max(1, Math.floor(box.width));
    const h = Math.max(1, Math.floor(box.height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private ndc(e: { clientX: number; clientY: number }): THREE.Vector2 {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private pick(e: PointerEvent): string | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const hit = this.raycaster.intersectObjects(this.nodes.children, true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && !o.userData.nodeId) o = o.parent;
    return (o?.userData.nodeId as string | undefined) ?? null;
  }

  /** Where a screen point meets the terrain (or the y = 0 plane). */
  private groundPoint(e: { clientX: number; clientY: number }): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const hit = this.raycaster.intersectObjects([...this.terrain.children, this.ground], false)[0];
    return hit ? hit.point : null;
  }

  /** Keep the dragged object at ground + offset while it moves across the terrain. */
  private followGround(obj: THREE.Object3D): void {
    const g = this.heightAt(obj.position.x, obj.position.z) ?? 0;
    const offset = this.snapTerrain ? 0 : obj.position.y - this.lastGround;
    obj.position.y = g + offset;
    this.lastGround = g;
  }

  private commit(id: string, obj: THREE.Object3D): void {
    const g = this.heightAt(obj.position.x, obj.position.z) ?? 0;
    this.handlers.onTransform(id, {
      position: [round(obj.position.x), round(obj.position.y - g), round(obj.position.z)],
      yawDeg: round(obj.rotation.y * DEG),
      scale: [round(obj.scale.x), round(obj.scale.y), round(obj.scale.z)],
    });
  }

  setMode(mode: GizmoMode): void {
    this.mode = mode;
    this.gizmo.setMode(mode);
    // Yaw is the only rotation the game world uses; snapped to terrain, a node cannot leave the ground.
    this.gizmo.showX = mode !== "rotate";
    this.gizmo.showZ = mode !== "rotate";
    this.gizmo.showY = mode !== "translate" || !this.snapTerrain;
  }

  /** View toggles (the toolbar's viewport options). */
  setGrid(on: boolean): void {
    this.grid.visible = on;
  }

  setGizmos(on: boolean): void {
    this.gizmosOn = on;
    this.gizmo.getHelper().visible = on;
    this.gizmo.enabled = on;
  }

  setWireframe(on: boolean): void {
    this.wireframe = on;
    const apply = (o: THREE.Object3D): void => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && "wireframe" in m) (m as THREE.MeshStandardMaterial).wireframe = on;
    };
    this.terrain.children.forEach(apply);
    this.nodes.traverse(apply);
  }

  /** A PNG of the viewport as drawn now (renders first, so the buffer is current). */
  screenshot(): Promise<Blob | null> {
    this.renderer.render(this.scene, this.camera);
    return new Promise((resolve) => this.canvas.toBlob((b) => resolve(b), "image/png"));
  }

  setSnap(opts: { terrain: boolean; grid: boolean }): void {
    this.snapTerrain = opts.terrain;
    this.setMode(this.mode);
    this.gizmo.setTranslationSnap(opts.grid ? 0.5 : null);
    this.gizmo.setRotationSnap(opts.grid ? Math.PI / 12 : null);
  }

  /** The world terrain under the scene (chunk meshes), also used for snapping and drops. */
  setTerrain(tiles: readonly HeightTile[], chunkSize: number): void {
    for (const m of [...this.terrain.children]) {
      (m as THREE.Mesh).geometry.dispose();
      this.terrain.remove(m);
    }
    this.heightAt = makeHeightSampler(tiles, chunkSize);
    let min = Infinity;
    let max = -Infinity;
    for (const t of tiles) {
      for (let i = 0; i < t.heights.length; i++) {
        min = Math.min(min, t.heights[i]);
        max = Math.max(max, t.heights[i]);
      }
    }
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, wireframe: this.wireframe });
    for (const t of tiles) {
      const mesh = new THREE.Mesh(buildChunkGeometry(chunkSize), material);
      mesh.position.set(t.cx * chunkSize + chunkSize / 2, 0, t.cz * chunkSize + chunkSize / 2);
      writeChunkGeometry(mesh.geometry, Float32Array.from(t.heights), { min, max });
      this.terrain.add(mesh);
    }
    // Nodes sit on the ground: redraw them now the ground is known.
    if (this.last) this.setDoc(...this.last);
  }

  /** Redraw the nodes for `doc` and attach the gizmo to `selected`. */
  setDoc(doc: SceneDoc, selected: string | null, species: ReadonlySet<string>): void {
    this.last = [doc, selected, species];
    this.gizmo.detach();
    for (const o of this.objects.values()) {
      this.nodes.remove(o);
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
    }
    this.objects.clear();
    for (const w of worldNodes(doc)) {
      const marker = markerFor(w.node, species);
      const group = new THREE.Group();
      group.userData.nodeId = w.node.id;
      const mesh = new THREE.Mesh(markerGeometry(marker.shape), new THREE.MeshStandardMaterial({ color: marker.color, roughness: 0.6, wireframe: this.wireframe }));
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: 0x000000 })));
      group.add(mesh);
      group.position.set(w.position[0], (this.heightAt(w.position[0], w.position[2]) ?? 0) + w.position[1], w.position[2]);
      group.rotation.y = (w.yawDeg / DEG);
      group.scale.set(...w.scale);
      this.nodes.add(group);
      this.objects.set(w.node.id, group);
    }
    this.selected = selected && this.objects.has(selected) ? selected : null;
    for (const [id, o] of this.objects) {
      const mesh = o.children[0] as THREE.Mesh;
      (mesh.material as THREE.MeshStandardMaterial).emissive.setHex(id === this.selected ? 0x666666 : 0x000000);
    }
    if (this.selected) this.gizmo.attach(this.objects.get(this.selected)!);
    this.gizmo.getHelper().visible = this.gizmosOn;
  }

  /** Move the camera to look at the selection (or the scene's centre). */
  frame(): void {
    const target = new THREE.Vector3();
    const sel = this.selected ? this.objects.get(this.selected) : undefined;
    if (sel) target.copy(sel.position);
    else if (this.objects.size > 0) {
      for (const o of this.objects.values()) target.add(o.position);
      target.divideScalar(this.objects.size);
    }
    this.orbit.target.copy(target);
    this.camera.position.copy(target).add(new THREE.Vector3(18, 14, 18));
  }

  /** Move the camera and its target to ground point (x, z), keeping the view angle. */
  lookAt(x: number, z: number): void {
    const y = this.heightAt(x, z) ?? 0;
    const delta = new THREE.Vector3(x, y, z).sub(this.orbit.target);
    this.orbit.target.add(delta);
    this.camera.position.add(delta);
    this.orbit.update();
  }

  /** Turn the free-fly camera on or off. Off hands control back to orbit, looking ahead. */
  setFly(on: boolean): void {
    if (on === this.flying) return;
    this.flying = on;
    this.keys.clear();
    this.orbit.enabled = !on && !this.gizmo.dragging;
    if (!on) {
      const ahead = new THREE.Vector3();
      this.camera.getWorldDirection(ahead);
      this.orbit.target.copy(this.camera.position).addScaledVector(ahead, 20);
      this.orbit.update();
    }
  }

  get isFlying(): boolean {
    return this.flying;
  }

  /** One frame of free-fly movement, along the view (flat) and up/down. */
  private fly(dt: number): void {
    const axes = flyAxes(this.keys);
    if (dt === 0 || (axes.forward === 0 && axes.right === 0 && axes.up === 0)) return;
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
    const boost = this.keys.has("shift") ? FLY_BOOST : 1;
    const step = FLY_SPEED * boost * dt;
    const move = new THREE.Vector3()
      .addScaledVector(forward, axes.forward * step)
      .addScaledVector(right, axes.right * step)
      .add(new THREE.Vector3(0, axes.up * step, 0));
    this.camera.position.add(move);
    this.orbit.target.add(move);
  }

  /** Where the camera looks, on the ground (for "place at the view centre"). */
  centre(): Vec3 {
    return [round(this.orbit.target.x), 0, round(this.orbit.target.z)];
  }

  /** Dolly the camera toward the orbit target (View menu Zoom In). */
  zoomIn(): void {
    const dir = this.camera.position.clone().sub(this.orbit.target);
    const len = dir.length();
    if (len > 1) {
      dir.setLength(len * 0.8);
      this.camera.position.copy(this.orbit.target).add(dir);
    }
  }

  /** Dolly the camera away from the orbit target (View menu Zoom Out). */
  zoomOut(): void {
    const dir = this.camera.position.clone().sub(this.orbit.target);
    const len = dir.length();
    if (len < 1000) {
      dir.setLength(len * 1.25);
      this.camera.position.copy(this.orbit.target).add(dir);
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.frameId);
    this.cleanup.forEach((f) => f());
    this.observer.disconnect();
    this.gizmo.dispose();
    this.orbit.dispose();
    this.renderer.dispose();
  }
}

const round = (n: number): number => Math.round(n * 1e4) / 1e4 + 0;
