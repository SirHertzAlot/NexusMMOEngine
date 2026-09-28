/**
 * Entity FX — spawn portals, selection ring, hover glow, motion trails.
 *
 * Purely visual, client-side only: positions come from the authoritative
 * mirror state, effects never simulate. One system per WorldView; call
 * `update(dt)` every frame from the render loop.
 */

import * as THREE from "three";
import { glowTexture } from "./element-fx.js";

const RING_VERT = /* glsl */ `
  varying vec2 vLocal;
  void main() {
    vLocal = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Expanding shockwave ring for spawn bursts. */
function makeBurstRing(maxRadius: number): {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
} {
  const mat = new THREE.ShaderMaterial({
    vertexShader: RING_VERT,
    fragmentShader: /* glsl */ `
      varying vec2 vLocal;
      uniform float uT;
      uniform vec3 uColor;
      void main() {
        float r = length(vLocal) / ${maxRadius.toFixed(2)};
        float band = smoothstep(0.16, 0.0, abs(r - uT));
        float a = (1.0 - uT) * (1.0 - uT) * band;
        gl_FragColor = vec4(uColor, a);
      }
    `,
    uniforms: { uT: { value: 0 }, uColor: { value: new THREE.Color(0x66eeff) } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.RingGeometry(0.01, maxRadius, 48), mat);
  mesh.rotation.x = -Math.PI / 2;
  return { mesh, mat };
}

/** Vertical light beam for spawn bursts. */
function makeBurstBeam(): { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } {
  const mat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform float uT;
      uniform vec3 uColor;
      void main() {
        float a = (1.0 - uT) * pow(1.0 - vUv.y, 2.0) * 0.55;
        gl_FragColor = vec4(uColor, a);
      }
    `,
    uniforms: { uT: { value: 0 }, uColor: { value: new THREE.Color(0x88f0ff) } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.55, 3.2, 20, 1, true), mat);
  return { mesh, mat };
}

interface Burst {
  ring: THREE.Mesh;
  ringMat: THREE.ShaderMaterial;
  beam: THREE.Mesh;
  beamMat: THREE.ShaderMaterial;
  t: number;
  dur: number;
}

/** Camera-facing fading ribbon that follows a moving entity. */
class Trail {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  private readonly max = 42;
  private points: THREE.Vector3[] = [];
  private lastPush = new THREE.Vector3(NaN, NaN, NaN);

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    color: number,
  ) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.max * 2 * 3), 3));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(this.max * 2), 1));
    const idx: number[] = [];
    for (let i = 0; i < this.max - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        uniform vec3 uColor;
        void main() { gl_FragColor = vec4(uColor, vAlpha * 0.55); }
      `,
      uniforms: { uColor: { value: new THREE.Color(color) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // Ribbon winding flips with travel direction; render both faces.
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  push(p: THREE.Vector3): void {
    if (!Number.isNaN(this.lastPush.x) && this.lastPush.distanceToSquared(p) < 0.09) return;
    this.lastPush.copy(p);
    this.points.unshift(p.clone());
    if (this.points.length > this.max) this.points.pop();
    this.rebuild();
  }

  private rebuild(): void {
    const geo = this.mesh.geometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const alp = geo.getAttribute("aAlpha") as THREE.BufferAttribute;
    const n = this.points.length;
    const dir = new THREE.Vector3();
    const view = new THREE.Vector3();
    const side = new THREE.Vector3();
    for (let i = 0; i < this.max; i++) {
      const p = this.points[Math.min(i, n - 1)] ?? new THREE.Vector3();
      const q = this.points[Math.min(i + 1, n - 1)] ?? p;
      dir.subVectors(p, q);
      if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
      dir.normalize();
      // Camera-facing strip: offset perpendicular to both travel and view.
      view.subVectors(this.camera.position, p).normalize();
      side.crossVectors(dir, view);
      if (side.lengthSq() < 1e-6) side.set(0, 1, 0);
      side.normalize().multiplyScalar(0.30 * (1 - i / this.max) + 0.05);
      const fade = n <= 1 ? 0 : Math.pow(1 - i / (n - 1), 1.6);
      const lift = p.y + 0.9;
      pos.setXYZ(i * 2, p.x - side.x, lift - side.y, p.z - side.z);
      pos.setXYZ(i * 2 + 1, p.x + side.x, lift + side.y, p.z + side.z);
      alp.setX(i * 2, fade);
      alp.setX(i * 2 + 1, fade);
    }
    pos.needsUpdate = true;
    alp.needsUpdate = true;
    geo.setDrawRange(0, Math.max(0, (n - 1) * 6));
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

const tmpV = new THREE.Vector3();

export class EntityFxSystem {
  private bursts: Burst[] = [];
  private readonly playerRing: THREE.Mesh;
  private readonly playerRingMat: THREE.ShaderMaterial;
  private readonly playerAura: THREE.Sprite;
  private readonly trail: Trail;
  private playerVisible = false;

  constructor(
    private readonly scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    // Persistent selection ring under the local player.
    this.playerRingMat = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vLocal;
        uniform float uTime;
        void main() {
          float r = length(vLocal);
          float band = smoothstep(0.10, 0.0, abs(r - 0.85));
          float pulse = 0.45 + 0.25 * sin(uTime * 3.0);
          gl_FragColor = vec4(vec3(0.35, 1.0, 0.55), band * pulse);
        }
      `,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.playerRing = new THREE.Mesh(new THREE.RingGeometry(0.55, 1.0, 48), this.playerRingMat);
    this.playerRing.rotation.x = -Math.PI / 2;
    this.playerRing.visible = false;
    this.playerRing.renderOrder = 4;
    scene.add(this.playerRing);

    this.playerAura = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture(),
        color: 0x44ff88,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.playerAura.scale.set(2.6, 2.6, 1);
    this.playerAura.visible = false;
    scene.add(this.playerAura);

    this.trail = new Trail(scene, camera, 0x44ff88);
  }

  /** Spawn portal: shockwave ring + light beam at a position. */
  spawnBurst(p: THREE.Vector3, color = 0x66eeff): void {
    const { mesh: ring, mat: ringMat } = makeBurstRing(2.6);
    ringMat.uniforms["uColor"]!.value = new THREE.Color(color);
    ring.position.set(p.x, 0.08, p.z);
    const { mesh: beam, mat: beamMat } = makeBurstBeam();
    beamMat.uniforms["uColor"]!.value = new THREE.Color(color);
    beam.position.set(p.x, 1.6, p.z);
    this.scene.add(ring, beam);
    this.bursts.push({ ring, ringMat, beam, beamMat, t: 0, dur: 0.9 });
  }

  /** Keep the selection ring + aura glued to the player (null hides). */
  setPlayerPos(p: THREE.Vector3 | null): void {
    this.playerVisible = p !== null;
    this.playerRing.visible = this.playerAura.visible = this.playerVisible;
    if (p) {
      this.playerRing.position.set(p.x, 0.07, p.z);
      this.playerAura.position.set(p.x, p.y + 0.8, p.z);
      this.trail.push(tmpV.set(p.x, 0, p.z));
    }
  }

  update(dt: number, time: number): void {
    this.playerRingMat.uniforms["uTime"]!.value = time;
    const aura = this.playerAura.material as THREE.SpriteMaterial;
    aura.opacity = 0.28 + 0.12 * Math.sin(time * 2.4);

    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.t += dt;
      const t = Math.min(1, b.t / b.dur);
      b.ringMat.uniforms["uT"]!.value = t;
      b.beamMat.uniforms["uT"]!.value = t;
      b.beam.scale.y = 1 - t * 0.7;
      if (t >= 1) {
        this.scene.remove(b.ring, b.beam);
        b.ring.geometry.dispose();
        b.ringMat.dispose();
        b.beam.geometry.dispose();
        b.beamMat.dispose();
        this.bursts.splice(i, 1);
      }
    }
  }

  dispose(): void {
    for (const b of this.bursts) {
      this.scene.remove(b.ring, b.beam);
      b.ring.geometry.dispose();
      b.ringMat.dispose();
      b.beam.geometry.dispose();
      b.beamMat.dispose();
    }
    this.bursts = [];
    this.scene.remove(this.playerRing, this.playerAura);
    this.playerRing.geometry.dispose();
    this.playerRingMat.dispose();
    (this.playerAura.material as THREE.Material).dispose();
    this.trail.dispose(this.scene);
  }
}
