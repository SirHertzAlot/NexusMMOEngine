/**
 * Procedural prop meshes for a dungeon run: every kind in content/dungeons/props.json gets a small, hard-edged mesh built
 * from boxes and cylinders (cones, bowls), so a sarcophagus reads as a sarcophagus even where no licensed model names it.
 * The run mounts them in its Pcg library under `dungeon:<kind>` (instance.ts), the way it mounts the shell, and the client
 * draws them like any PCG asset, colouring the material slots from the theme's look palette.
 *
 * Metres, Y up. Standing kinds rest on y = 0 (the entity stands on the floor); the mounted kinds (torch, banner) are
 * centred on their origin (the entity hangs at its `lift`). The front of a prop is +Z.
 */

import { encodePcgMesh } from "@mmo-engine/picg";

/** The material slots a prop mesh uses; the look's palette names a matte colour for each (content/dungeons/looks.json). */
export const PROP_SLOTS = ["stone", "wood", "metal", "cloth", "gold", "bone", "fire", "ice", "moss", "earth", "glass"] as const;
export type PropSlot = (typeof PROP_SLOTS)[number];

type V = [number, number, number];
interface Tri {
  p: [V, V, V];
  slot: PropSlot;
}

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A triangle wound counter-clockwise seen from the side `out` points to. */
function tri(slot: PropSlot, a: V, b: V, c: V, out: V): Tri[] {
  const n = cross(sub(b, a), sub(c, a));
  return [{ p: dot(n, out) < 0 ? [a, c, b] : [a, b, c], slot }];
}
const quad = (slot: PropSlot, a: V, b: V, c: V, d: V, out: V): Tri[] => [...tri(slot, a, b, c, out), ...tri(slot, a, c, d, out)];

/** A box `sx × sy × sz` centred on (cx, cy, cz), turned `yaw` about Y. */
function box(slot: PropSlot, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, yaw = 0): Tri[] {
  const [co, si] = [Math.cos(yaw), Math.sin(yaw)];
  const at = (i: number, j: number, k: number): V => {
    const [x, y, z] = [(i * sx) / 2, (j * sy) / 2, (k * sz) / 2];
    return [cx + x * co + z * si, cy + y, cz - x * si + z * co];
  };
  const dir = (i: number, j: number, k: number): V => [i * co + k * si, j, -i * si + k * co];
  const faces: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  return faces.flatMap(([i, j, k]) => {
    // The face's four corners: the two axes other than its own.
    const [u, v] = i ? [[0, 1, 0], [0, 0, 1]] : j ? [[1, 0, 0], [0, 0, 1]] : [[1, 0, 0], [0, 1, 0]];
    const corner = (a: number, b: number): V => at(i + u[0] * a + v[0] * b, j + u[1] * a + v[1] * b, k + u[2] * a + v[2] * b);
    return quad(slot, corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), dir(i, j, k));
  });
}

/** A cylinder (a cone or bowl when the radii differ) standing on y = `y0`, `rb` at the bottom, `rt` at the top, `seg` sides. */
function cyl(slot: PropSlot, cx: number, y0: number, cz: number, rb: number, h: number, rt = rb, seg = 10): Tri[] {
  const out: Tri[] = [];
  const ring = (r: number, y: number, i: number): V => [cx + r * Math.cos((i / seg) * Math.PI * 2), y, cz + r * Math.sin((i / seg) * Math.PI * 2)];
  const topPoint = rt <= 1e-3;
  for (let i = 0; i < seg; i++) {
    const [b0, b1] = [ring(rb, y0, i), ring(rb, y0, i + 1)];
    const mid: V = [b0[0] + b1[0] - 2 * cx, 0, b0[2] + b1[2] - 2 * cz];
    if (topPoint) out.push(...tri(slot, b0, b1, [cx, y0 + h, cz], mid));
    else out.push(...quad(slot, b0, b1, ring(rt, y0 + h, i + 1), ring(rt, y0 + h, i), mid));
    if (!topPoint) out.push(...tri(slot, [cx, y0 + h, cz], ring(rt, y0 + h, i), ring(rt, y0 + h, i + 1), [0, 1, 0]));
    if (rb > 1e-3) out.push(...tri(slot, [cx, y0, cz], b0, b1, [0, -1, 0]));
  }
  return out;
}

const all = (...parts: Tri[][]): Tri[] => parts.flat();
/** `n` copies of `part(i, angle)` evenly round the Y axis. */
const around = (n: number, part: (i: number, a: number) => Tri[]): Tri[] => Array.from({ length: n }, (_, i) => part(i, (i / n) * Math.PI * 2)).flat();

/** A lidded chest: `wood` body and lid, `band` straps and lock. */
const chest = (band: PropSlot): Tri[] =>
  all(
    box("wood", 0, 0.25, 0, 0.9, 0.5, 0.55),
    box("wood", 0, 0.61, 0, 0.94, 0.22, 0.59),
    box(band, -0.3, 0.37, 0, 0.07, 0.74, 0.6),
    box(band, 0.3, 0.37, 0, 0.07, 0.74, 0.6),
    box(band, 0, 0.5, 0.3, 0.1, 0.14, 0.05),
  );

const candle = (x: number, z: number, h: number): Tri[] => all(cyl("bone", x, 0.03, z, 0.04, h), cyl("fire", x, 0.03 + h, z, 0.028, 0.08, 0, 6));

const RECIPES: Record<string, () => Tri[]> = {
  pillar: () => all(box("stone", 0, 0.2, 0, 1.0, 0.4, 1.0), cyl("stone", 0, 0.4, 0, 0.38, 4.4, 0.34, 12), box("stone", 0, 5.0, 0, 1.0, 0.4, 1.0)),
  brazier: () => all(cyl("metal", 0, 0, 0, 0.3, 0.08), cyl("metal", 0, 0.08, 0, 0.08, 0.62), cyl("metal", 0, 0.7, 0, 0.22, 0.3, 0.5), cyl("fire", 0, 0.98, 0, 0.36, 0.34, 0, 8)),
  banner: () => all(box("wood", 0, 1.0, 0, 1.0, 0.07, 0.07), box("cloth", 0, 0.0, 0, 0.8, 2.0, 0.04), box("gold", 0, 0.7, 0.025, 0.4, 0.4, 0.01)),
  shrineCrystal: () => all(box("stone", 0, 0.15, 0, 0.8, 0.3, 0.8), cyl("glass", 0, 0.3, 0, 0.001, 0.5, 0.3, 6), cyl("glass", 0, 0.8, 0, 0.3, 1.2, 0.001, 6)),
  ring: () => all(cyl("stone", 0, 0, 0, 1.5, 0.06, 1.5, 16), cyl("gold", 0, 0, 0, 1.2, 0.08, 1.2, 16), cyl("stone", 0, 0, 0, 1.05, 0.09, 1.05, 16)),
  bossCrystal: () => all(cyl("stone", 0, 0, 0, 0.8, 0.4, 0.7, 10), cyl("glass", 0, 0.4, 0, 0.001, 0.8, 0.6, 6), cyl("glass", 0, 1.2, 0, 0.6, 2.2, 0.001, 6)),
  grave: () => all(box("earth", 0, 0.1, 0.1, 0.9, 0.2, 1.8), box("stone", 0, 0.525, -0.85, 0.8, 1.05, 0.16), box("stone", 0, 1.1, -0.85, 0.5, 0.1, 0.16)),
  sarcophagus: () => all(box("stone", 0, 0.125, 0, 1.0, 0.25, 2.2), box("stone", 0, 0.475, 0, 0.9, 0.45, 2.0), box("stone", 0, 0.8, 0, 0.96, 0.2, 2.06), box("gold", 0, 0.5, 0, 0.94, 0.06, 2.04), box("bone", 0, 0.95, -0.55, 0.5, 0.1, 0.5)),
  candle: () => candle(0, 0, 0.22),
  iceShard: () => all(cyl("ice", 0, 0, 0, 0.3, 0.95, 0.001, 6), cyl("ice", 0.28, 0, 0.1, 0.17, 0.6, 0.001, 6), cyl("ice", -0.22, 0, -0.12, 0.14, 0.5, 0.001, 6)),
  torch: () => all(cyl("wood", 0, -0.3, 0, 0.035, 0.5), cyl("metal", 0, 0.2, 0, 0.06, 0.12, 0.09), cyl("fire", 0, 0.32, 0, 0.09, 0.24, 0, 8), box("metal", 0, -0.05, -0.06, 0.05, 0.05, 0.12)),
  anvil: () => all(box("stone", 0, 0.15, 0, 0.5, 0.3, 0.4), box("metal", 0, 0.475, 0, 0.3, 0.35, 0.26), box("metal", 0, 0.775, 0, 0.8, 0.25, 0.34), cyl("metal", 0.4, 0.66, 0, 0.14, 0.2, 0.02, 6)),
  "armour-stand": () => all(cyl("wood", 0, 0, 0, 0.3, 0.08), cyl("wood", 0, 0.08, 0, 0.04, 1.5), box("metal", 0, 1.3, 0, 0.5, 0.6, 0.26), box("metal", 0, 1.62, 0, 0.8, 0.12, 0.22), cyl("metal", 0, 1.68, 0, 0.13, 0.25, 0.1), box("cloth", 0, 1.0, 0.14, 0.4, 0.3, 0.02)),
  barrel: () => all(cyl("wood", 0, 0, 0, 0.34, 0.3, 0.4), cyl("wood", 0, 0.3, 0, 0.4, 0.3, 0.4), cyl("wood", 0, 0.6, 0, 0.4, 0.3, 0.34), cyl("metal", 0, 0.12, 0, 0.375, 0.06), cyl("metal", 0, 0.7, 0, 0.375, 0.06), cyl("wood", 0, 0.9, 0, 0.32, 0.03)),
  bedroll: () => all(box("cloth", 0, 0.03, 0, 0.8, 0.06, 1.8), box("cloth", 0, 0.11, -0.7, 0.6, 0.1, 0.3), box("earth", 0, 0.1, 0.2, 0.7, 0.08, 1.0)),
  bookshelf: () => all(box("wood", 0, 1.1, -0.17, 1.2, 2.2, 0.06), box("wood", -0.57, 1.1, 0, 0.06, 2.2, 0.4), box("wood", 0.57, 1.1, 0, 0.06, 2.2, 0.4), ...[0.03, 0.46, 0.9, 1.34, 1.78, 2.17].map((y) => box("wood", 0, y, 0, 1.2, 0.05, 0.4)), ...[0.25, 0.68, 1.12, 1.56].flatMap((y, i) => [box("cloth", -0.3, y, 0.02, 0.5 - 0.06 * i, 0.32, 0.22), box("earth", 0.22, y - 0.02, 0.02, 0.4, 0.28, 0.22)])),
  cage: () => all(cyl("metal", 0, 0, 0, 0.55, 0.06, 0.55, 12), cyl("metal", 0, 1.5, 0, 0.55, 0.06, 0.5, 12), around(8, (_i, a) => box("metal", 0.5 * Math.cos(a), 0.78, 0.5 * Math.sin(a), 0.04, 1.44, 0.04)), box("bone", 0.1, 0.15, 0, 0.35, 0.18, 0.2, 0.5)),
  candles: () => all(cyl("metal", 0, 0, 0, 0.3, 0.03, 0.28), candle(0, 0, 0.2), candle(0.14, 0.1, 0.12), candle(-0.12, 0.12, 0.16)),
  chest: () => chest("metal"),
  coffin: () => all(box("wood", 0, 0.25, 0, 0.7, 0.5, 2.0), box("wood", 0, 0.56, 0, 0.78, 0.12, 2.08), box("metal", 0, 0.63, 0.2, 0.5, 0.02, 0.06), box("metal", 0, 0.63, 0.2, 0.06, 0.02, 0.5)),
  "coin-pile": () => all(cyl("gold", 0, 0, 0, 0.45, 0.14, 0.2, 9), cyl("gold", 0.2, 0, 0.12, 0.2, 0.2, 0.05, 7), cyl("gold", -0.18, 0, -0.1, 0.16, 0.18, 0.03, 7), box("gold", 0.38, 0.015, -0.2, 0.12, 0.03, 0.12, 0.6)),
  crate: () => all(box("wood", 0, 0.45, 0, 0.84, 0.84, 0.84), ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z]) => box("wood", x * 0.4, 0.45, z * 0.4, 0.1, 0.9, 0.1)), box("wood", 0, 0.88, 0, 0.9, 0.04, 0.9), box("metal", 0, 0.45, 0.43, 0.7, 0.07, 0.02)),
  desk: () => all(box("wood", 0, 0.82, 0, 1.5, 0.08, 0.8), ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z]) => box("wood", x * 0.68, 0.39, z * 0.34, 0.09, 0.78, 0.09)), box("wood", 0.45, 0.6, 0.0, 0.5, 0.25, 0.7), box("cloth", -0.3, 0.87, 0.05, 0.4, 0.015, 0.3, 0.2)),
  "frozen-body": () => all(box("ice", 0, 0.3, 0, 0.8, 0.6, 0.8), box("bone", 0, 0.22, 0, 0.5, 0.2, 0.3, 0.4), box("cloth", 0.1, 0.34, 0.05, 0.3, 0.12, 0.25, 0.4)),
  "gilded-chest": () => chest("gold"),
  "ice-pillar": () => all(cyl("ice", 0, 0, 0, 0.5, 2.0, 0.36, 8), cyl("ice", 0, 2.0, 0, 0.36, 1.6, 0.001, 8)),
  mushrooms: () => all(cyl("bone", 0, 0, 0, 0.06, 0.38, 0.05, 6), cyl("moss", 0, 0.34, 0, 0.2, 0.14, 0.04, 8), cyl("bone", 0.22, 0, 0.1, 0.05, 0.22, 0.04, 6), cyl("moss", 0.22, 0.2, 0.1, 0.15, 0.1, 0.03, 8), cyl("bone", -0.16, 0, -0.12, 0.04, 0.16, 0.04, 6), cyl("moss", -0.16, 0.14, -0.12, 0.11, 0.08, 0.03, 8)),
  pew: () => all(box("wood", 0, 0.45, 0, 1.8, 0.08, 0.5), box("wood", -0.86, 0.22, 0, 0.08, 0.44, 0.5), box("wood", 0.86, 0.22, 0, 0.08, 0.44, 0.5), box("wood", 0, 0.68, -0.22, 1.8, 0.45, 0.06), box("wood", -0.86, 0.7, -0.05, 0.08, 0.4, 0.4)),
  reliquary: () => all(box("stone", 0, 0.3, 0, 0.6, 0.6, 0.5), box("gold", 0, 0.78, 0, 0.5, 0.3, 0.34), box("gold", 0, 0.98, 0, 0.54, 0.1, 0.38), cyl("gold", 0, 1.03, 0, 0.1, 0.12, 0.001, 6), box("glass", 0, 0.8, 0.175, 0.24, 0.16, 0.01)),
  "ritual-circle": () => all(cyl("stone", 0, 0, 0, 1.35, 0.05, 1.35, 20), cyl("gold", 0, 0, 0, 1.25, 0.07, 1.25, 20), cyl("stone", 0, 0, 0, 1.12, 0.09, 1.12, 20), cyl("fire", 0, 0, 0, 0.3, 0.1, 0.3, 10), around(4, (_i, a) => box("bone", 0.8 * Math.cos(a), 0.05, 0.8 * Math.sin(a), 0.16, 0.1, 0.16, a))),
  "root-knot": () => all(cyl("wood", 0, 0, 0, 0.3, 1.1, 0.14, 8), cyl("wood", 0.3, 0, 0.1, 0.16, 0.7, 0.02, 6), cyl("wood", -0.25, 0, -0.18, 0.15, 0.6, 0.02, 6), cyl("wood", 0.05, 0, 0.3, 0.13, 0.5, 0.02, 6), cyl("moss", 0, 0.9, 0, 0.18, 0.2, 0.05, 6)),
  rubble: () => all(box("stone", 0, 0.2, 0, 0.55, 0.4, 0.45, 0.3), box("stone", 0.4, 0.12, 0.2, 0.4, 0.24, 0.3, 0.9), box("stone", -0.35, 0.15, 0.25, 0.35, 0.3, 0.4, 1.4), box("stone", 0.1, 0.35, -0.05, 0.3, 0.3, 0.3, 0.6), box("stone", 0.05, 0.06, 0.5, 0.3, 0.12, 0.22, 0.2), box("earth", -0.1, 0.02, -0.4, 0.5, 0.04, 0.35)),
  sack: () => all(cyl("cloth", 0, 0, 0, 0.32, 0.45, 0.22, 9), cyl("cloth", 0, 0.45, 0, 0.14, 0.12, 0.19, 8), cyl("wood", 0, 0.5, 0, 0.145, 0.03, 0.145, 8)),
  smelter: () => all(box("metal", 0, 0.06, 0, 1.5, 0.12, 1.3), box("stone", 0, 0.87, 0, 1.4, 1.5, 1.2), cyl("stone", 0, 1.62, -0.2, 0.3, 0.6, 0.26, 8), box("metal", 0, 0.6, 0.6, 0.7, 0.55, 0.06), box("fire", 0, 0.6, 0.64, 0.5, 0.35, 0.02), box("metal", 0.5, 1.55, 0.5, 0.2, 0.1, 0.2)),
  statue: () => all(box("stone", 0, 0.3, 0, 1.0, 0.6, 1.0), cyl("stone", 0, 0.6, 0, 0.35, 1.4, 0.26, 10), box("stone", 0, 1.9, 0, 0.7, 0.2, 0.3), cyl("stone", 0, 2.0, 0, 0.14, 0.34, 0.12, 8), box("metal", 0.3, 1.2, 0.2, 0.06, 1.1, 0.06), box("stone", 0.3, 1.55, 0.18, 0.12, 0.5, 0.12)),
  table: () => all(box("wood", 0, 0.83, 0, 1.6, 0.1, 1.0), ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z]) => box("wood", x * 0.7, 0.39, z * 0.4, 0.1, 0.78, 0.1)), box("wood", 0, 0.65, 0, 1.3, 0.06, 0.08)),
  throne: () => all(box("stone", 0, 0.25, 0.05, 1.0, 0.5, 0.8), box("stone", 0, 1.0, -0.35, 1.0, 2.0, 0.2), box("stone", -0.58, 0.45, 0.05, 0.16, 0.9, 0.8), box("stone", 0.58, 0.45, 0.05, 0.16, 0.9, 0.8), box("cloth", 0, 0.55, 0.05, 0.84, 0.1, 0.7), box("gold", 0, 1.85, -0.24, 0.8, 0.14, 0.03), box("gold", 0, 1.3, -0.24, 0.5, 0.5, 0.02)),
  urn: () => all(cyl("earth", 0, 0, 0, 0.15, 0.3, 0.3, 10), cyl("earth", 0, 0.3, 0, 0.3, 0.3, 0.2, 10), cyl("earth", 0, 0.6, 0, 0.2, 0.12, 0.12, 10), cyl("gold", 0, 0.72, 0, 0.17, 0.05, 0.17, 10), cyl("gold", 0, 0.4, 0, 0.305, 0.04, 0.305, 10)),
  "weapon-rack": () => all(box("wood", 0, 0.05, 0, 1.4, 0.1, 0.4), box("wood", -0.65, 0.7, 0, 0.08, 1.3, 0.08), box("wood", 0.65, 0.7, 0, 0.08, 1.3, 0.08), box("wood", 0, 1.3, 0, 1.4, 0.07, 0.07), box("wood", 0, 0.75, 0, 1.4, 0.07, 0.07), box("metal", -0.4, 0.8, 0.05, 0.05, 1.2, 0.02, 0.1), box("metal", -0.1, 0.8, 0.07, 0.07, 1.0, 0.02, -0.15), box("metal", 0.2, 0.75, 0.05, 0.05, 1.1, 0.02), box("wood", 0.45, 0.9, 0.06, 0.05, 1.4, 0.05), box("metal", 0.45, 1.5, 0.06, 0.12, 0.22, 0.02)),
};

export const PROP_KINDS: readonly string[] = Object.keys(RECIPES);

/** A kind's mesh as PCGM bytes (positions, flat normals and one material slot per triangle), or null for a kind with no recipe. */
export function propMesh(kind: string): Uint8Array | null {
  const recipe = RECIPES[kind];
  if (!recipe) return null;
  const tris = recipe();
  const materials = PROP_SLOTS.filter((s) => tris.some((t) => t.slot === s));
  const positions = new Float32Array(tris.length * 9);
  const normals = new Float32Array(tris.length * 9);
  const indices = new Uint32Array(tris.length * 3);
  const triangleMaterials = new Uint32Array(tris.length);
  tris.forEach((t, i) => {
    const n = cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0]));
    const len = Math.hypot(...n) || 1;
    t.p.forEach((v, k) => {
      positions.set(v, i * 9 + k * 3);
      normals.set([n[0] / len, n[1] / len, n[2] / len], i * 9 + k * 3);
      indices[i * 3 + k] = i * 3 + k;
    });
    triangleMaterials[i] = materials.indexOf(t.slot);
  });
  return encodePcgMesh({ positions, indices, normals, materials: [...materials], triangleMaterials });
}
