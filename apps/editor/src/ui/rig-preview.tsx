/**
 * RigPreview — the procedural animal rig (WL2) on one converted model, for a
 * designer to check that the skeleton fits the mesh and the gait reads right.
 *
 * The shared rig (`@mmo-engine/animal-rig`) cuts the mesh into bones by shape,
 * skins it, and poses it from a speed. This view shows the rig type it chose,
 * the bones as lines over the mesh, and a speed slider that drives the gait.
 * Developer tool: the game client never shows it.
 */

import * as React from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { AnimalTemplate } from "@mmo-engine/animal-rig";

/** One position-only geometry of every mesh in the model, in the model's own space. */
function positionsOf(root: THREE.Object3D): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.getAttribute("position")) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", mesh.geometry.getAttribute("position").clone());
    if (mesh.geometry.index) g.setIndex(mesh.geometry.index.clone());
    g.applyMatrix4(mesh.matrixWorld);
    parts.push(g);
  });
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  // mergeGeometries needs an index on every part or on none: drop the index, keep positions.
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  return mergeGeometries(flat, false);
}

export function RigPreview({ url, modelName }: { url: string; modelName: string }): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = React.useState("loading…");
  const [speed, setSpeed] = React.useState(0);
  const speedRef = React.useRef(0);
  speedRef.current = speed;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let frame = 0;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1, false);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1020);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(3, 5, 4);
    scene.add(sun);
    scene.add(new THREE.GridHelper(10, 10, 0x445066, 0x2a3040));
    const camera = new THREE.PerspectiveCamera(45, (canvas.clientWidth || 1) / (canvas.clientHeight || 1), 0.01, 5000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    const clock = new THREE.Clock();
    let rig: import("@mmo-engine/animal-rig").AnimalRig | null = null;
    let helper: THREE.SkeletonHelper | null = null;
    let model: THREE.Object3D | null = null;

    setStatus("loading…");
    new GLTFLoader().load(
      url,
      (gltf) => {
        if (disposed) return;
        model = gltf.scene;
        const geometry = positionsOf(model);
        const template = geometry ? AnimalTemplate.from(geometry, undefined, modelName) : null;
        if (!template) {
          setStatus("not a four-legged or named animal: no rig");
          scene.add(model);
          return;
        }
        // The rig replaces the mesh: it is the skinned copy the template made.
        const material = new THREE.MeshStandardMaterial({ color: 0xb8a68a, roughness: 0.8, metalness: 0, transparent: true, opacity: 0.55 });
        rig = template.create(material);
        scene.add(rig.root);
        helper = new THREE.SkeletonHelper(rig.root);
        scene.add(helper);
        const box = new THREE.Box3().setFromObject(rig.root);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(size.x, size.y, size.z, 0.1);
        controls.target.copy(center);
        camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.8, radius * 1.2));
        camera.near = radius / 1000;
        camera.far = radius * 100;
        camera.updateProjectionMatrix();
        setStatus(`rig: ${template.seg.type}, ${template.seg.boneNames?.length ?? 0} bones`);
      },
      undefined,
      (err) => setStatus(`load failed: ${err instanceof Error ? err.message : String(err)}`),
    );

    const tick = () => {
      if (disposed) return;
      const dt = Math.min(clock.getDelta(), 0.1);
      // Speed in metres per second from the slider; the gait blends with it.
      if (rig) rig.update(dt, { speed: speedRef.current, attackT: -1, hitAt: 0, attackDuration: 0, dead: false }, true);
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      controls.dispose();
      if (rig) {
        rig.dispose();
        scene.remove(rig.root);
      }
      if (helper) helper.dispose();
      if (model) model.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
      });
      renderer.dispose();
    };
  }, [url, modelName]);

  return (
    <div className="flex flex-col gap-2">
      <canvas ref={canvasRef} className="h-72 w-full rounded-md border border-input" />
      <div className="flex items-center gap-3 text-sm">
        <span className="text-muted-foreground">{status}</span>
        <label className="flex items-center gap-2">
          Speed
          <input
            type="range"
            min={0}
            max={8}
            step={0.1}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            aria-label="Gait speed in metres per second"
          />
          <span className="tabular-nums">{speed.toFixed(1)} m/s</span>
        </label>
      </div>
    </div>
  );
}
