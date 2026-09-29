/**
 * UnderwaterEffect — what the camera sees below the water surface: colours
 * lose red and go blue-green, distance fades into murk (by depth, so near
 * things stay clear and far ones vanish), and the image wobbles gently.
 *
 * `amount` (0..1) blends it in; WorldCanvas sets it every frame from how
 * far the camera is below the surface, so crossing the surface is a
 * short fade, not a pop. At 0 the effect passes the image through.
 */

import { BlendFunction, Effect, EffectAttribute } from "postprocessing";
import * as THREE from "three";

const FRAGMENT = /* glsl */ `
uniform float amount;
uniform vec3 tint;
uniform vec3 murk;
uniform float murkDensity;

void mainUv(inout vec2 uv) {
  // Refraction wobble, strongest when fully under.
  uv += amount * 0.0025 * vec2(sin(uv.y * 38.0 + time * 1.9), cos(uv.x * 31.0 + time * 1.6));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  float distance = -getViewZ(depth);
  float fog = 1.0 - exp(-distance * murkDensity);
  vec3 under = mix(inputColor.rgb * tint, murk, fog);
  outputColor = vec4(mix(inputColor.rgb, under, amount), inputColor.a);
}
`;

export interface UnderwaterOptions {
  /** Colour filter on everything seen through the water (linear RGB). */
  tint?: THREE.ColorRepresentation;
  /** Colour distance fades into. */
  murk?: THREE.ColorRepresentation;
  /** How fast the murk closes in (1/m): at 0.06, half-hidden at ~12 m. */
  murkDensity?: number;
}

export class UnderwaterEffect extends Effect {
  constructor({ tint = 0x6fb7c4, murk = 0x0d3a4a, murkDensity = 0.06 }: UnderwaterOptions = {}) {
    super("UnderwaterEffect", FRAGMENT, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, THREE.Uniform>([
        ["amount", new THREE.Uniform(0)],
        ["tint", new THREE.Uniform(new THREE.Color(tint))],
        ["murk", new THREE.Uniform(new THREE.Color(murk))],
        ["murkDensity", new THREE.Uniform(murkDensity)],
      ]),
    });
  }

  /** 0 = above water (no effect), 1 = fully under. */
  get amount(): number {
    return this.uniforms.get("amount")!.value as number;
  }

  set amount(v: number) {
    this.uniforms.get("amount")!.value = Math.max(0, Math.min(1, v));
  }
}

/** How much of the underwater look to show, from the camera's depth below the surface (m). */
export function underwaterAmount(depthBelowSurface: number): number {
  // A 30 cm band either side of the surface fades it in.
  const t = (depthBelowSurface + 0.05) / 0.3;
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}
