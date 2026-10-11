/**
 * Colour helpers behind the Materials panel's toon preview (roadmap EA22):
 * the document stores linear RGB, the screen shows sRGB hex, and the preview
 * ball shades one ramp row the way the client's toon shader does (a preview
 * of the look, not a copy of the shader).
 */
import type { Rgb } from "@mmo-engine/art/browser";

const toSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);

/** A linear RGB colour (0..1 each) as the #rrggbb the screen shows. */
export function linearToHex(c: readonly [number, number, number]): string {
  return `#${c.map((v) => byte(toSrgb(Math.min(1, Math.max(0, v)))).toString(16).padStart(2, "0")).join("")}`;
}

export function hexToLinear(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)].map((v) => Math.round(v * 1000) / 1000) as Rgb;
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / Math.max(1e-6, e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * The toon colour at a surface point lit with `nDotL` (-1..1): the
 * half-Lambert term cut into shadow and lit by the band edges, the shadow
 * taken from the ramp (darkest at the far side, its edge near the band),
 * a rim on grazing angles.
 */
export function toonColour(
  nDotL: number,
  nDotV: number,
  base: Rgb,
  ramp: [Rgb, Rgb],
  toon: { band: [number, number]; rim: number; rimPower: number },
): Rgb {
  const half = nDotL * 0.5 + 0.5;
  const lit = smooth(toon.band[0], toon.band[1], half);
  const depth = smooth(0, toon.band[0], half);
  const out = [0, 1, 2].map((c) => {
    const shadow = (ramp[0][c] + (ramp[1][c] - ramp[0][c]) * depth) * base[c];
    return shadow + (base[c] - shadow) * lit;
  });
  const rim = toon.rim * (1 - Math.max(0, nDotV)) ** toon.rimPower * lit;
  return out.map((v) => Math.min(1, v + rim)) as Rgb;
}
