/**
 * ModelPreview — render one converted model (GLB + its external atlas)
 * so a designer can check scale, orientation, and texturing by eye.
 *
 * One viewport per mounted preview; everything it loads (geometry,
 * materials, textures) is disposed when the model changes or the preview
 * unmounts.
 */

import * as React from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export function ModelPreview({ url }: { url: string }): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = React.useState("loading…");

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1, false);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1020);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(3, 5, 4);
    scene.add(sun);
    // 1 m grid: judge scale at a glance (a door ~2 m, a barrel ~1 m).
    const grid = new THREE.GridHelper(10, 10, 0x445066, 0x2a3040);
    scene.add(grid);
    const camera = new THREE.PerspectiveCamera(45, (canvas.clientWidth || 1) / (canvas.clientHeight || 1), 0.01, 5000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    let model: THREE.Object3D | null = null;

    setStatus("loading…");
    new GLTFLoader().load(
      url,
      (gltf) => {
        if (disposed) return disposeObject(gltf.scene);
        model = gltf.scene;
        scene.add(model);
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(size.x, size.y, size.z, 0.1);
        controls.target.copy(center);
        camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.8, radius * 1.2));
        camera.near = radius / 1000;
        camera.far = radius * 100;
        camera.updateProjectionMatrix();
        let triangles = 0;
        model.traverse((o) => {
          const g = (o as THREE.Mesh).geometry;
          if (g) triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
        });
        setStatus(`${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m · ${Math.round(triangles)} tris`);
      },
      undefined,
      (err) => {
        if (!disposed) setStatus(`failed: ${err instanceof Error ? err.message : String(err)}`);
      },
    );

    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });

    return () => {
      disposed = true;
      renderer.setAnimationLoop(null);
      controls.dispose();
      if (model) disposeObject(model);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
    };
  }, [url]);

  return (
    <div className="flex flex-col gap-1">
      <canvas ref={canvasRef} className="block h-72 w-full rounded-md" />
      <p className="text-xs text-muted-foreground">
        {status} · drag to orbit, wheel to zoom · grid squares are 1 m
      </p>
    </div>
  );
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  });
}
