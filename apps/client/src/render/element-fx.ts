/**
 * Element FX — six animated elemental orb shaders.
 *
 * Water, fire, wind, earth, snow, lava — each a self-contained
 * ShaderMaterial on a sphere "orb". Fully procedural (fbm noise +
 * domain-specific motion); no downloaded textures, so there is zero
 * licensing baggage.
 *
 * Also exports tiny runtime-generated sprite textures (soft glow, spark)
 * drawn on canvas — used by entity-fx for auras and bursts.
 */

import * as THREE from "three";
import { NOISE_GLSL } from "./glsl.js";

export type ElementKind = "water" | "fire" | "wind" | "earth" | "snow" | "lava";

export const ELEMENTS: ElementKind[] = [
  "water",
  "fire",
  "wind",
  "earth",
  "snow",
  "lava",
];

const VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

function fragBody(kind: ElementKind): string {
  switch (kind) {
    case "fire":
      return /* glsl */ `
        vec2 p = vUv * vec2(3.0, 4.0);
        float n = fxFbm(p + vec2(0.0, -uTime * 2.2));
        float n2 = fxFbm(p * 2.3 + vec2(3.7, -uTime * 3.4));
        float flame = smoothstep(0.2, 0.95, n * 0.65 + n2 * 0.45 + (1.0 - vUv.y) * 0.30);
        float flicker = 0.88 + 0.12 * sin(uTime * 13.0 + vUv.x * 20.0);
        vec3 col = mix(vec3(0.30, 0.02, 0.0), vec3(1.0, 0.32, 0.02), flame);
        col = mix(col, vec3(1.0, 0.85, 0.45), pow(flame, 3.0));
        col *= flicker * shade;
        gl_FragColor = vec4(col, 1.0);
      `;
    case "water":
      return /* glsl */ `
        vec2 p = vUv * 6.0;
        float w1 = sin(p.x * 2.0 + fxFbm(p * 0.8 + uTime * 0.6) * 9.0 + uTime * 2.4);
        float w2 = sin(p.y * 2.6 - fxFbm(p * 0.6 - uTime * 0.4) * 7.0 - uTime * 1.8);
        float ripple = 0.5 + 0.25 * w1 + 0.25 * w2;
        float sparkle = pow(fxNoise(p * 3.0 + uTime * 0.8), 5.0);
        vec3 col = mix(vec3(0.02, 0.18, 0.38), vec3(0.15, 0.55, 0.85), ripple);
        col += vec3(0.7, 0.9, 1.0) * sparkle * 0.9;
        col *= shade;
        gl_FragColor = vec4(col, 0.92);
      `;
    case "wind":
      return /* glsl */ `
        vec2 c = vUv - 0.5;
        float ang = atan(c.y, c.x);
        float streak = fxFbm(vec2(ang * 2.5, vUv.y * 9.0 - uTime * 3.2));
        float streak2 = fxFbm(vec2(ang * 5.0 + 2.0, (1.0 - vUv.y) * 7.0 - uTime * 4.1));
        float wisp = smoothstep(0.35, 0.9, streak * 0.6 + streak2 * 0.4);
        vec3 col = mix(vec3(0.55, 0.75, 0.85), vec3(0.95, 1.0, 1.0), wisp);
        col *= shade;
        gl_FragColor = vec4(col, 0.25 + wisp * 0.65);
      `;
    case "earth":
      return /* glsl */ `
        vec2 p = vUv * 5.0;
        float rock = fxFbm(p);
        float strata = fxFbm(vec2(p.x * 0.6, p.y * 2.4));
        vec3 col = mix(vec3(0.23, 0.16, 0.10), vec3(0.42, 0.36, 0.30), rock);
        col = mix(col, vec3(0.30, 0.24, 0.20), smoothstep(0.4, 0.7, strata) * 0.6);
        float moss = smoothstep(0.58, 0.75, fxFbm(p * 1.7 + 4.2));
        col = mix(col, vec3(0.18, 0.38, 0.12), moss * 0.8);
        col *= shade;
        gl_FragColor = vec4(col, 1.0);
      `;
    case "snow":
      return /* glsl */ `
        vec2 p = vUv * 8.0;
        float drift = fxFbm(p * 0.8 + uTime * 0.15);
        float glint = pow(fxNoise(p * 4.0), 12.0)
          * (0.4 + 0.6 * sin(uTime * 2.5 + vUv.x * 30.0 + vUv.y * 22.0));
        vec3 col = mix(vec3(0.75, 0.83, 0.94), vec3(0.97, 0.99, 1.0), drift);
        col += vec3(1.0) * max(glint, 0.0) * 2.0;
        col *= shade;
        gl_FragColor = vec4(col, 1.0);
      `;
    case "lava":
      return /* glsl */ `
        vec2 p = vUv * 4.0;
        float crustN = fxFbm(p + uTime * 0.05);
        float crack = pow(smoothstep(0.55, 0.95, fxRidge(p * 1.4)), 1.5);
        float pulse = 0.6 + 0.4 * sin(uTime * 2.0 - crack * 10.0);
        vec3 crust = mix(vec3(0.08, 0.05, 0.05), vec3(0.22, 0.10, 0.08), crustN);
        vec3 magma = mix(vec3(0.9, 0.15, 0.0), vec3(1.0, 0.75, 0.2), pulse * crack);
        vec3 col = mix(crust, magma, crack) * shade;
        col += magma * crack * pulse * 0.8;
        gl_FragColor = vec4(col, 1.0);
      `;
  }
}

export function makeElementMaterial(kind: ElementKind): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormal;
      uniform float uTime;
      ${NOISE_GLSL}
      void main() {
        float shade = 0.55 + 0.45 * clamp(vNormal.y * 0.5 + 0.6, 0.0, 1.0);
        ${fragBody(kind)}
      }
    `,
    uniforms: { uTime: { value: 0 } },
    transparent: kind === "water" || kind === "wind",
  });
}

/** Advance an element material's clock. */
export function tickElementMaterial(mat: THREE.ShaderMaterial, t: number): void {
  const u = mat.uniforms["uTime"] as THREE.IUniform | undefined;
  if (u) u.value = t;
}

// ---------------------------------------------------------------------------
// Procedural sprite textures (canvas-generated, no downloads / no licensing)
// ---------------------------------------------------------------------------

let glowTex: THREE.Texture | null = null;
let sparkTex: THREE.Texture | null = null;

function radialTexture(
  stops: Array<[number, string]>,
  size = 128,
): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/** Soft radial glow sprite. */
export function glowTexture(): THREE.Texture {
  if (!glowTex) {
    glowTex = radialTexture([
      [0, "rgba(255,255,255,1)"],
      [0.35, "rgba(255,255,255,0.45)"],
      [1, "rgba(255,255,255,0)"],
    ]);
  }
  return glowTex;
}

/** Tight spark sprite. */
export function sparkTexture(): THREE.Texture {
  if (!sparkTex) {
    sparkTex = radialTexture([
      [0, "rgba(255,255,255,1)"],
      [0.15, "rgba(255,255,255,0.9)"],
      [0.4, "rgba(255,255,255,0.15)"],
      [1, "rgba(255,255,255,0)"],
    ], 64);
  }
  return sparkTex;
}

/** Text label sprite (for the FX showcase). */
export function labelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = "600 42px system-ui, sans-serif";
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 40;
  canvas.width = w;
  canvas.height = 72;
  const c2 = canvas.getContext("2d")!;
  c2.font = font;
  c2.textAlign = "center";
  c2.textBaseline = "middle";
  c2.shadowColor = "rgba(0,0,0,0.9)";
  c2.shadowBlur = 10;
  c2.fillStyle = "rgba(235,245,255,0.95)";
  c2.fillText(text, w / 2, 38);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(w / 72, 1, 1);
  return sprite;
}
