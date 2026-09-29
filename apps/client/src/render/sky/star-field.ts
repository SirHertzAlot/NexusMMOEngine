/**
 * StarField — the night sky: two Milky Way bands and a sparse field of
 * stars, drawn as camera-facing points on the sky dome, turning with the
 * time of day about a tilted pole and fading in as the sun sets.
 *
 * Adapted from Vercel's Next.js Nights galaxy shader (MIT, © 2026 Vercel;
 * see THIRD_PARTY_NOTICES.md), which is WebGPU/TSL: here it is GLSL on
 * WebGL, the stars are seeded (every player sees the same sky), and the
 * band's cluster noise is computed once on the CPU instead of per vertex.
 * Kept from the original: the sech² band profile with a second offset
 * band, the bright-star fraction, the two-colour palette, the three-sine
 * twinkle scaled by star size, and the on-screen size clamp.
 */

import * as THREE from "three";

export interface StarFieldOptions {
  /** Stars in each of the two Milky Way bands. */
  bandCount: number;
  /** Stars spread evenly over the sky. */
  fieldCount: number;
  /** sech² band half-thickness, radians of galactic latitude. */
  bandThickness: number;
  /** The second band's latitude offset, radians. */
  band2Offset: number;
  /** Share of stars drawn noticeably larger (the bright foreground ones). */
  brightFraction: number;
  /** Largest star on screen, CSS pixels. */
  maxPixels: number;
  seed: number;
}

export const DEFAULT_STAR_FIELD: StarFieldOptions = {
  bandCount: 24_000,
  fieldCount: 5_000,
  bandThickness: 0.07,
  band2Offset: -0.175,
  brightFraction: 0.08,
  maxPixels: 5.5,
  seed: 0x5eed57a2,
};

/** Latitude of the observer: the pole stands this high above the northern horizon. */
const POLE_ELEVATION = THREE.MathUtils.degToRad(40);
/** Where the galactic plane lies against the celestial sphere (fixed, like the real one). */
const GALACTIC_TILT = new THREE.Euler(0.43, 0, -0.47);
const RADIUS = 900;

const BAND_BLUE = [0.75, 0.85, 1.0] as const;
const BAND_WHITE = [1.0, 0.95, 0.85] as const;
const FIELD_WHITE = [0.95, 0.95, 0.95] as const;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 3D value noise in [0, 1] (hashed lattice, trilinear with a smoothstep fade). */
function valueNoise(x: number, y: number, z: number): number {
  const hash = (i: number, j: number, k: number): number => {
    let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(k, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  };
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fade = (t: number): number => t * t * (3 - 2 * t);
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const c = (i: number, j: number, k: number): number => hash(xi + i, yi + j, zi + k);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

/** Three-octave fBm of value noise, in [0, 1]. */
function fbm(x: number, y: number, z: number): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let o = 0; o < 3; o++) {
    sum += valueNoise(x * f, y * f, z * f) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Per-star data for the instanced attributes. */
export interface StarAttributes {
  /** Unit directions on the celestial sphere (before the sky's turn). */
  directions: Float32Array;
  colors: Float32Array;
  /** On-screen size, CSS pixels. */
  sizes: Float32Array;
  /** Two twinkle frequencies per star, rad/s. */
  twinkles: Float32Array;
  count: number;
}

/** The stars for a seed: the same options always give the same sky. */
export function buildStars(options: StarFieldOptions = DEFAULT_STAR_FIELD): StarAttributes {
  const o = options;
  const rand = mulberry32(o.seed);
  const count = o.bandCount * 2 + o.fieldCount;
  const directions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const twinkles = new Float32Array(count * 2);
  const tilt = new THREE.Matrix4().makeRotationFromEuler(GALACTIC_TILT);
  const v = new THREE.Vector3();
  let i = 0;

  const scale = (base: number, range: number): number =>
    rand() < o.brightFraction ? 1.8 + rand() * 2.2 : base + rand() * range;

  const write = (x: number, y: number, z: number, rgb: readonly number[], starScale: number, brightness: number): void => {
    v.set(x, y, z).applyMatrix4(tilt).normalize();
    directions.set([v.x, v.y, v.z], i * 3);
    const cv = (0.85 + rand() * 0.3) * brightness;
    colors.set([rgb[0] * cv, rgb[1] * cv, rgb[2] * cv], i * 3);
    sizes[i] = Math.min(starScale * 2.3, o.maxPixels);
    twinkles[i * 2] = 1.5 + rand() * 8.5;
    twinkles[i * 2 + 1] = 1.5 + rand() * 8.5;
    i++;
  };

  // The bands: sech²-distributed latitude about the galactic plane, the
  // brightness clumped by two layers of noise (the galaxy's star clouds).
  for (const offset of [0, o.band2Offset]) {
    for (let n = 0; n < o.bandCount; n++) {
      const t = Math.max(-0.995, Math.min(0.995, 2 * rand() - 1));
      const b = o.bandThickness * Math.atanh(t) + offset;
      const l = rand() * Math.PI * 2;
      const x = Math.cos(b) * Math.cos(l), y = Math.sin(b), z = Math.cos(b) * Math.sin(l);
      const coarse = Math.pow(fbm(x * 9 + 11, y * 9, z * 9), 1.43);
      const fine = Math.pow(fbm(x * 33, y * 33 + 7, z * 33), 1.28);
      const clump = (1 - 0.57 + 0.57 * Math.min(1, coarse * 1.6)) * (1 - 0.83 + 0.83 * Math.min(1, fine * 1.6));
      write(x, y, z, rand() < 0.3 ? BAND_BLUE : BAND_WHITE, scale(0.4, 0.55), clump);
    }
  }
  // The field: uniform over the sphere, a little dimmer.
  for (let n = 0; n < o.fieldCount; n++) {
    const phi = rand() * Math.PI * 2;
    const cosTheta = rand() * 2 - 1;
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    write(sinTheta * Math.cos(phi), cosTheta, sinTheta * Math.sin(phi), rand() < 0.15 ? BAND_BLUE : FIELD_WHITE, scale(0.35, 0.5), 0.8);
  }
  return { directions, colors, sizes, twinkles, count };
}

/**
 * The sky's turn at a time of day: one revolution a day about the pole,
 * which stands POLE_ELEVATION above the northern horizon (north is -z).
 */
export function skyRotation(time: number, out = new THREE.Matrix3()): THREE.Matrix3 {
  const axis = new THREE.Vector3(0, Math.sin(POLE_ELEVATION), -Math.cos(POLE_ELEVATION));
  const m = new THREE.Matrix4().makeRotationAxis(axis, -time * Math.PI * 2);
  return out.setFromMatrix4(m);
}

/** How much of the starlight shows for a sun direction's height (0 by day, 1 at full night). */
export function starVisibility(sunY: number): number {
  return THREE.MathUtils.smoothstep(-sunY, -0.15, 0.1);
}

const VERTEX = /* glsl */ `
attribute vec3 aDirection;
attribute vec3 aColor;
attribute float aSize;
attribute vec2 aTwinkle;
uniform mat3 uRotation;
uniform float uTime;
uniform float uNight;
uniform float uTwinkle;
uniform vec2 uResolution;
uniform float uPixelRatio;
varying vec3 vColor;
varying vec2 vUv;

void main() {
  vec3 dir = uRotation * aDirection;
  // Stars sink into the horizon haze.
  float horizon = smoothstep(-0.02, 0.15, dir.y);

  // Three sines per star: a slow, non-repeating shimmer; the big stars shimmer most.
  float t = uTime * 0.42;
  float a = sin(t * aTwinkle.x + aTwinkle.x * 13.7);
  float b = sin(t * aTwinkle.y + aTwinkle.y * 7.3);
  float fc = aTwinkle.x * aTwinkle.y * 0.1;
  float c = sin(t * fc + fc * 3.1);
  float shimmer = clamp((a + 0.5 * b + 0.2 * c) / 3.4 + 0.5, 0.3, 1.0);
  float twinkle = 1.0 - clamp(uTwinkle * aSize / 2.3, 0.0, 1.0) * (1.0 - shimmer);

  vColor = aColor * twinkle * uNight * horizon;
  vUv = position.xy * 2.0;

  vec4 clip = projectionMatrix * viewMatrix * vec4(cameraPosition + dir * ${RADIUS.toFixed(1)}, 1.0);
  clip.xy += position.xy * aSize * uPixelRatio * 2.0 / uResolution * clip.w;
  // On the far plane, behind everything but the dome.
  clip.z = clip.w * 0.99995;
  gl_Position = clip;
  // Invisible stars (day, below the horizon): off screen, no fragments.
  if (max(vColor.r, max(vColor.g, vColor.b)) < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying vec2 vUv;

void main() {
  float falloff = pow(max(1.0 - length(vUv), 0.0), 2.0);
  if (falloff <= 0.0) discard;
  gl_FragColor = vec4(vColor * falloff, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class StarField {
  readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  readonly uniforms = {
    uRotation: { value: new THREE.Matrix3() },
    uTime: { value: 0 },
    uNight: { value: 0 },
    uTwinkle: { value: 0.4 },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uPixelRatio: { value: 1 },
  };

  constructor(options: StarFieldOptions = DEFAULT_STAR_FIELD) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry.index = quad.index;
    this.geometry.setAttribute("position", quad.getAttribute("position"));
    quad.dispose();
    const stars = buildStars(options);
    this.geometry.setAttribute("aDirection", new THREE.InstancedBufferAttribute(stars.directions, 3));
    this.geometry.setAttribute("aColor", new THREE.InstancedBufferAttribute(stars.colors, 3));
    this.geometry.setAttribute("aSize", new THREE.InstancedBufferAttribute(stars.sizes, 1));
    this.geometry.setAttribute("aTwinkle", new THREE.InstancedBufferAttribute(stars.twinkles, 2));
    this.geometry.instanceCount = stars.count;
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = "star-field";
    this.mesh.frustumCulled = false;
    // First among the transparent things, so the water and particles draw over it.
    this.mesh.renderOrder = -999;
  }

  /** Turn the sky to a time of day and show as much of it as the sun allows. */
  update(time: number, sunY: number, strength = 1): void {
    skyRotation(time, this.uniforms.uRotation.value);
    this.uniforms.uNight.value = starVisibility(sunY) * strength;
    this.mesh.visible = this.uniforms.uNight.value > 0.002;
  }

  /** The drawing size and seconds elapsed (for the twinkle); call each frame. */
  setFrame(width: number, height: number, pixelRatio: number, seconds: number): void {
    this.uniforms.uResolution.value.set(Math.max(1, width * pixelRatio), Math.max(1, height * pixelRatio));
    this.uniforms.uPixelRatio.value = pixelRatio;
    this.uniforms.uTime.value = seconds;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
