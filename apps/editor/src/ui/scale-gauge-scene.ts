/**
 * The Scale view's three.js preview: per category, a human-height capsule
 * (1.8 m) beside a box of the category's typical scaled height, so a 40 m
 * "house" or a knee-high tree reads at a glance. Two InstancedMeshes (one
 * capsule, one box) carry every pair; an update rewrites instance matrices in
 * place with reused scratch objects, and the scene renders on demand (on
 * update and resize), so nothing allocates per frame. `dispose` frees the
 * geometry, materials and renderer.
 */
import * as THREE from "three";
import { gaugeLayout, type Gauge, type GaugeStatus } from "../scale-model.js";

const MAX_PAIRS = 8;
const COLORS: Record<GaugeStatus, number> = { ok: 0x9cd67d, low: 0xe8a33d, high: 0xffb4ab, none: 0x667080 };

export interface GaugeScene {
  update(gauge: Gauge): void;
  resize(): void;
  dispose(): void;
}

export function createGaugeScene(canvas: HTMLCanvasElement): GaugeScene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1020);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(3, 6, 8);
  scene.add(sun);
  const camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 100);
  camera.position.set(0, 0, 20);

  // Unit capsule 1 m tall (radius 0.17, body 0.66) scaled to the character's height; unit cube sitting on y = 0.
  const capsuleGeo = new THREE.CapsuleGeometry(0.17, 0.66, 4, 12);
  capsuleGeo.translate(0, 0.5, 0);
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  boxGeo.translate(0, 0.5, 0);
  const capsuleMat = new THREE.MeshStandardMaterial({ color: 0xb9c3ff });
  const boxMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
  const capsules = new THREE.InstancedMesh(capsuleGeo, capsuleMat, MAX_PAIRS);
  const boxes = new THREE.InstancedMesh(boxGeo, boxMat, MAX_PAIRS);
  capsules.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  boxes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  boxes.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PAIRS * 3), 3);
  capsules.count = boxes.count = 0;
  const groundMat = new THREE.MeshBasicMaterial({ color: 0x445066 });
  const ground = new THREE.Mesh(boxGeo, groundMat); // a strip under y = 0, sized per frame
  scene.add(capsules, boxes, ground);

  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const col = new THREE.Color();
  let layout = gaugeLayout({ character: 1.8, rows: [] });

  const frame = (): void => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    // Keep metres square: widen the frame to the canvas's aspect when the layout is narrower.
    const right = Math.max(layout.right, layout.top * (w / h));
    camera.left = 0;
    camera.right = right;
    camera.bottom = -layout.top * 0.04;
    camera.top = layout.top;
    camera.updateProjectionMatrix();
    ground.scale.set(right, layout.top * 0.04, 1);
    ground.position.set(right / 2, -layout.top * 0.04, -1);
    renderer.render(scene, camera);
  };

  return {
    update(next) {
      const gauge = next;
      layout = gaugeLayout(gauge);
      const n = Math.min(layout.items.length, MAX_PAIRS);
      for (let i = 0; i < n; i++) {
        const it = layout.items[i];
        pos.set(it.characterX, 0, 0);
        scl.set(1, gauge.character, 1);
        capsules.setMatrixAt(i, m4.compose(pos, quat, scl));
        pos.set(it.boxX, 0, 0);
        scl.set(it.width, it.height, Math.min(it.width, 6));
        boxes.setMatrixAt(i, m4.compose(pos, quat, scl));
        boxes.setColorAt(i, col.setHex(COLORS[it.status]));
      }
      capsules.count = boxes.count = n;
      capsules.instanceMatrix.needsUpdate = boxes.instanceMatrix.needsUpdate = true;
      if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;
      frame();
    },
    resize: frame,
    dispose() {
      capsuleGeo.dispose();
      boxGeo.dispose();
      capsuleMat.dispose();
      boxMat.dispose();
      capsules.dispose();
      boxes.dispose();
      groundMat.dispose();
      renderer.dispose();
    },
  };
}
