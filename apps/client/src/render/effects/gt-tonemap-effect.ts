/**
 * GTToneMapEffect — Hajime Uchimura's Gran Turismo tone curve, which
 * Genshin Impact also uses. The curve has three parts:
 * - a toe that tightens the blacks
 * - a long linear middle, so colours and the toon ramps keep their
 *   painted values
 * - a shoulder that rolls highlights off smoothly towards the maximum
 *   brightness, instead of clipping them
 *
 * The composer turns the renderer's own tone mapping off, so without an
 * effect like this, bright values clip at 1.
 *
 * Adapted from KallkaGo's ToonShading (MIT, see THIRD_PARTY_NOTICES.md).
 * `gtTonemap` is the same curve in TypeScript, for tests and tools.
 */

import { BlendFunction, Effect } from "postprocessing";
import * as THREE from "three";

export interface GTToneMapParams {
  /** Maximum brightness out. Default 1. */
  maxLuminance: number;
  /** Contrast (slope of the linear part). Default 1. */
  contrast: number;
  /** Where the linear part starts. Default 0.22. */
  linearStart: number;
  /** How long the linear part is. Default 0.4. */
  linearLength: number;
  /** Black tightness: the toe's curvature. Default 1.33. */
  blackTightness: number;
  /** Black tightness: the toe's pedestal. Default 0. */
  blackPedestal: number;
}

export const GT_DEFAULTS: GTToneMapParams = {
  maxLuminance: 1,
  contrast: 1,
  linearStart: 0.22,
  linearLength: 0.4,
  blackTightness: 1.33,
  blackPedestal: 0,
};

/** The Gran Turismo curve for one channel (linear in, display-referred out). */
export function gtTonemap(x: number, p: GTToneMapParams = GT_DEFAULTS): number {
  const { maxLuminance: P, contrast: a, linearStart: m, linearLength: l, blackTightness: c, blackPedestal: b } = p;
  const l0 = ((P - m) * l) / a;
  const S0 = m + l0;
  const S1 = m + a * l0;
  const C2 = (a * P) / (P - S1);
  const L = m + a * (x - m);
  const T = m * Math.pow(Math.max(x, 0) / m, c) + b;
  const S = P - (P - S1) * Math.exp((-C2 * (x - S0)) / P);
  const w0 = 1 - smooth(x, 0, m);
  const w2 = x >= S0 ? 1 : 0;
  const w1 = 1 - w0 - w2;
  return T * w0 + L * w1 + S * w2;
}

function smooth(x: number, e0: number, e1: number): number {
  if (x <= e0) return 0;
  if (x >= e1) return 1;
  const t = (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
}

const FRAGMENT = /* glsl */ `
uniform float P;
uniform float a;
uniform float m;
uniform float l;
uniform float c;
uniform float b;

vec3 gtCurve(vec3 x) {
  float l0 = (P - m) * l / a;
  float S0 = m + l0;
  float S1 = m + a * l0;
  float C2 = a * P / (P - S1);
  vec3 L = m + a * (x - m);
  vec3 T = m * pow(max(x, 0.0) / m, vec3(c)) + b;
  vec3 S = P - (P - S1) * exp(-C2 * (x - S0) / P);
  vec3 w0 = 1.0 - smoothstep(0.0, m, x);
  vec3 w2 = step(S0, x);
  vec3 w1 = 1.0 - w0 - w2;
  return T * w0 + L * w1 + S * w2;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = vec4(gtCurve(inputColor.rgb), inputColor.a);
}
`;

export class GTToneMapEffect extends Effect {
  constructor(params: Partial<GTToneMapParams> = {}) {
    const p = { ...GT_DEFAULTS, ...params };
    super("GTToneMapEffect", FRAGMENT, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ["P", new THREE.Uniform(p.maxLuminance)],
        ["a", new THREE.Uniform(p.contrast)],
        ["m", new THREE.Uniform(p.linearStart)],
        ["l", new THREE.Uniform(p.linearLength)],
        ["c", new THREE.Uniform(p.blackTightness)],
        ["b", new THREE.Uniform(p.blackPedestal)],
      ]),
    });
  }
}
