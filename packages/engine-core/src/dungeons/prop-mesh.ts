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

/** A coffin in a wall niche (hung on the wall, centred on its lift, facing +Z): a stone frame, a dark recess, the coffin's end and a plate. */
const niche = (): Tri[] => all(box("stone", 0, 0, 0, 1.2, 0.9, 0.12), box("earth", 0, 0, 0.065, 0.95, 0.65, 0.02), box("wood", 0, 0, 0.1, 0.8, 0.5, 0.08), box("wood", 0, 0, 0.14, 0.7, 0.4, 0.02), box("gold", 0, 0.05, 0.16, 0.12, 0.08, 0.015), box("bone", 0, -0.12, 0.16, 0.1, 0.1, 0.015), box("stone", 0, -0.42, 0.08, 1.3, 0.06, 0.2));

/** `parts` raised by `dy`. */
const lift = (parts: Tri[], dy: number): Tri[] => parts.map(({ p, slot }) => ({ p: p.map(([x, y, z]) => [x, y + dy, z]) as Tri["p"], slot }));

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
  /** An opened, emptied chest (what a run swaps an opened chest to): the dark inside showing, the lid stood up at the back. */
  "chest-open": () => all(box("wood", 0, 0.25, 0, 0.9, 0.5, 0.55), box("earth", 0, 0.505, 0, 0.8, 0.01, 0.45), box("wood", 0, 0.8, -0.32, 0.94, 0.59, 0.1), box("metal", -0.3, 0.25, 0, 0.07, 0.5, 0.6), box("metal", 0.3, 0.25, 0, 0.07, 0.5, 0.6)),
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
  "bunk-bed": () => all(...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z]) => box("wood", x * 0.46, 0.85, z * 0.96, 0.08, 1.7, 0.08)), box("wood", 0, 0.38, 0, 0.94, 0.06, 1.96), box("cloth", 0, 0.46, 0.05, 0.84, 0.1, 1.8), box("bone", 0, 0.54, -0.75, 0.5, 0.08, 0.3), box("wood", 0, 1.08, 0, 0.94, 0.06, 1.96), box("cloth", 0, 1.16, 0.05, 0.84, 0.1, 1.8), box("bone", 0, 1.24, -0.75, 0.5, 0.08, 0.3), box("wood", 0.46, 0.8, 0.5, 0.05, 1.5, 0.05), box("wood", 0.46, 0.8, 0.9, 0.05, 1.5, 0.05), ...[0.5, 0.8, 1.1, 1.4].map((y) => box("wood", 0.46, y, 0.7, 0.05, 0.05, 0.45))),
  footlocker: () => all(box("wood", 0, 0.19, 0, 0.8, 0.38, 0.48), box("wood", 0, 0.43, 0, 0.82, 0.1, 0.5), box("metal", -0.3, 0.3, 0, 0.06, 0.5, 0.52), box("metal", 0.3, 0.3, 0, 0.06, 0.5, 0.52), box("metal", 0, 0.3, 0.25, 0.1, 0.12, 0.03)),
  "gear-locker": () => all(box("metal", 0, 1.0, 0, 0.7, 2.0, 0.56), box("wood", -0.17, 1.0, 0.285, 0.3, 1.8, 0.02), box("wood", 0.17, 1.0, 0.285, 0.3, 1.8, 0.02), ...[1.6, 1.7, 1.8].map((y) => box("metal", 0, y, 0.29, 0.5, 0.025, 0.01)), box("gold", 0, 1.0, 0.3, 0.05, 0.12, 0.03)),
  "sword-rack": () => all(box("wood", 0, 0.05, 0, 1.4, 0.1, 0.4), box("wood", -0.65, 0.7, 0, 0.08, 1.3, 0.08), box("wood", 0.65, 0.7, 0, 0.08, 1.3, 0.08), box("wood", 0, 1.3, 0, 1.4, 0.07, 0.07), box("wood", 0, 0.7, 0, 1.4, 0.07, 0.07), ...[-0.45, -0.15, 0.15, 0.45].flatMap((x) => [box("metal", x, 0.9, 0.04, 0.05, 1.1, 0.015), box("gold", x, 0.42, 0.04, 0.2, 0.04, 0.03), box("wood", x, 0.3, 0.04, 0.04, 0.2, 0.03)])),
  "spear-rack": () => all(box("wood", 0, 0.05, 0, 1.4, 0.1, 0.4), box("wood", -0.65, 1.1, 0, 0.08, 2.0, 0.08), box("wood", 0.65, 1.1, 0, 0.08, 2.0, 0.08), box("wood", 0, 1.5, 0, 1.4, 0.07, 0.07), box("wood", 0, 0.5, 0, 1.4, 0.07, 0.07), ...[-0.45, -0.22, 0, 0.22, 0.45].flatMap((x) => [box("wood", x, 1.05, 0.05, 0.04, 2.0, 0.04), cyl("metal", x, 2.02, 0.05, 0.05, 0.18, 0.001, 5)])),
  "bow-rack": () => all(box("wood", 0, 0.05, 0, 1.2, 0.1, 0.4), box("wood", -0.55, 0.65, 0, 0.08, 1.2, 0.08), box("wood", 0.55, 0.65, 0, 0.08, 1.2, 0.08), box("wood", 0, 1.2, 0, 1.2, 0.07, 0.07), ...[-0.3, 0, 0.3].flatMap((x, i) => [box("wood", x, 0.78, 0.05, 0.04, 1.3, 0.04, i * 0.1), box("cloth", x + 0.05, 0.78, 0.07, 0.01, 1.2, 0.01)]), box("wood", 0.4, 0.3, 0.1, 0.25, 0.5, 0.2), ...[0.34, 0.42, 0.5].map((x) => box("bone", x, 0.62, 0.1, 0.02, 0.18, 0.02))),
  "shield-rack": () => all(box("wood", 0, 0.05, 0, 1.2, 0.1, 0.5), box("wood", -0.55, 0.55, -0.15, 0.08, 1.1, 0.08), box("wood", 0.55, 0.55, -0.15, 0.08, 1.1, 0.08), box("wood", 0, 1.1, -0.15, 1.2, 0.07, 0.07), ...[-0.35, 0, 0.35].flatMap((x, i) => [box("metal", x, 0.65, 0.02, 0.45, 0.7, 0.05, i * 0.15 - 0.15), box("gold", x, 0.65, 0.07, 0.14, 0.14, 0.04, i * 0.15 - 0.15), box("cloth", x, 0.65, 0.052, 0.3, 0.12, 0.012, i * 0.15 - 0.15)])),
  workbench: () => all(box("wood", 0, 0.95, 0, 1.6, 0.1, 0.8), ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z]) => box("wood", x * 0.72, 0.45, z * 0.32, 0.1, 0.9, 0.1)), box("wood", 0, 0.25, 0, 1.4, 0.06, 0.6), box("metal", -0.6, 1.1, 0.2, 0.15, 0.2, 0.2), box("metal", 0.1, 1.03, -0.1, 0.3, 0.05, 0.06), box("wood", 0.4, 1.03, 0.1, 0.05, 0.05, 0.3), box("metal", 0.4, 1.03, 0.28, 0.14, 0.06, 0.08)),
  lectern: () => all(box("wood", 0, 0.05, 0, 0.5, 0.1, 0.5), box("wood", 0, 0.6, 0, 0.25, 1.0, 0.25), box("wood", 0, 1.17, 0, 0.62, 0.12, 0.5), box("wood", 0, 1.27, 0.2, 0.62, 0.06, 0.06), box("cloth", 0, 1.26, -0.02, 0.5, 0.05, 0.36), box("bone", 0, 1.295, -0.02, 0.44, 0.02, 0.3)),
  "scroll-rack": () => all(box("wood", 0, 0.8, -0.12, 1.2, 1.6, 0.06), box("wood", -0.57, 0.8, 0, 0.06, 1.6, 0.3), box("wood", 0.57, 0.8, 0, 0.06, 1.6, 0.3), ...[0.03, 0.43, 0.83, 1.23, 1.58].map((y) => box("wood", 0, y, 0, 1.2, 0.05, 0.3)), ...[0.22, 0.62, 1.02, 1.4].flatMap((y) => [-0.4, -0.13, 0.14, 0.41].map((x) => box("bone", x, y, 0.05, 0.14, 0.14, 0.24))), box("cloth", 0.1, 0.62, 0.17, 0.12, 0.12, 0.02)),
  bench: () => all(box("wood", 0, 0.42, 0, 1.8, 0.08, 0.4), box("wood", -0.78, 0.2, 0, 0.1, 0.4, 0.34), box("wood", 0.78, 0.2, 0, 0.1, 0.4, 0.34), box("wood", 0, 0.12, 0, 1.5, 0.06, 0.06)),
  "reading-table": () => all(box("wood", 0, 0.85, 0, 1.8, 0.08, 1.0), box("wood", -0.8, 0.4, 0, 0.1, 0.8, 0.9), box("wood", 0.8, 0.4, 0, 0.1, 0.8, 0.9), box("wood", 0, 0.3, 0, 1.5, 0.06, 0.08), box("cloth", -0.4, 0.92, 0.1, 0.4, 0.06, 0.3, 0.2), box("bone", -0.4, 0.955, 0.1, 0.36, 0.02, 0.26, 0.2), box("cloth", 0.3, 0.92, -0.1, 0.34, 0.05, 0.26, -0.3), lift(candle(0.65, 0.2, 0.07), 0.89)),
  "long-table": () => all(box("wood", 0, 0.85, 0, 3.2, 0.1, 1.0), ...[-1.4, 0, 1.4].map((x) => box("wood", x, 0.4, 0, 0.12, 0.8, 0.9)), box("wood", 0, 0.28, 0, 2.9, 0.06, 0.08), ...[-1.1, -0.4, 0.5, 1.2].flatMap((x) => [cyl("metal", x, 0.9, 0.25, 0.12, 0.03), cyl("bone", x + 0.2, 0.9, -0.2, 0.05, 0.1, 0.06, 6)])),
  "candle-stand": () => all(cyl("metal", 0, 0, 0, 0.25, 0.05, 0.22), cyl("metal", 0, 0.05, 0, 0.04, 1.25), cyl("metal", 0, 1.3, 0, 0.06, 0.04, 0.2), cyl("metal", 0, 1.34, 0, 0.19, 0.03), ...[[0, 0], [0.1, 0.06], [-0.1, 0.06], [0, -0.11]].flatMap(([x, z], i) => [cyl("bone", x, 1.37, z, 0.035, 0.1 + i * 0.01), cyl("fire", x, 1.47 + i * 0.01, z, 0.025, 0.08, 0.001, 5)])),
  altar: () => all(box("stone", -0.7, 0.45, 0, 0.5, 0.9, 0.9), box("stone", 0.7, 0.45, 0, 0.5, 0.9, 0.9), box("stone", 0, 0.9, 0, 2.0, 0.2, 1.0), box("cloth", 0, 1.015, 0, 1.6, 0.03, 0.7), box("gold", 0, 1.05, 0, 0.08, 0.3, 0.04), box("gold", 0, 1.12, 0, 0.26, 0.07, 0.04), lift(candle(-0.6, 0.1, 0.12), 1.03)),
  "statue-large": () => all(box("stone", 0, 0.4, 0, 2.0, 0.8, 2.0), box("stone", 0, 0.9, 0, 1.4, 0.2, 1.4), cyl("stone", 0, 1.0, 0, 0.7, 2.3, 0.45, 12), box("stone", 0, 3.25, 0, 1.5, 0.3, 0.7), box("stone", -0.85, 3.9, 0, 0.26, 1.3, 0.26), box("stone", 0.85, 3.9, 0, 0.26, 1.3, 0.26), cyl("stone", 0, 3.4, 0, 0.3, 0.7, 0.26, 10), cyl("gold", 0, 4.05, -0.05, 0.5, 0.05, 0.5, 14), box("metal", 0.9, 3.4, 0.3, 0.06, 1.8, 0.06), box("gold", 0.9, 2.55, 0.3, 0.4, 0.08, 0.08)),
  stocks: () => all(box("wood", 0, 0.08, 0, 1.4, 0.16, 0.8), box("wood", -0.55, 0.75, 0, 0.12, 1.3, 0.12), box("wood", 0.55, 0.75, 0, 0.12, 1.3, 0.12), box("wood", 0, 0.82, 0, 1.2, 0.14, 0.1), box("wood", 0, 1.0, 0, 1.2, 0.14, 0.1), box("metal", 0, 1.07, 0.06, 0.1, 0.1, 0.03), box("metal", 0.4, 0.91, 0.06, 0.08, 0.08, 0.03)),
  "guard-desk": () => all(box("wood", 0, 0.96, 0, 1.8, 0.08, 0.9), box("wood", -0.86, 0.46, 0, 0.08, 0.92, 0.8), box("wood", 0.86, 0.46, 0, 0.08, 0.92, 0.8), box("wood", 0, 0.5, -0.36, 1.6, 0.9, 0.06), box("wood", 0.5, 0.65, 0, 0.5, 0.25, 0.8), box("cloth", -0.4, 1.02, 0.1, 0.45, 0.02, 0.32, 0.3), cyl("metal", 0.2, 1.0, 0.2, 0.07, 0.18, 0.05, 8), box("gold", 0.4, 1.02, -0.2, 0.1, 0.04, 0.06)),
  hearth: () => all(box("stone", 0, 0.08, 0.1, 2.4, 0.16, 1.4), box("stone", -0.95, 0.85, -0.15, 0.5, 1.7, 0.6), box("stone", 0.95, 0.85, -0.15, 0.5, 1.7, 0.6), box("stone", 0, 1.85, -0.15, 2.4, 0.3, 0.6), box("stone", 0, 0.85, -0.4, 1.4, 1.7, 0.1), cyl("fire", 0, 0.16, -0.1, 0.4, 0.55, 0.001, 8), box("wood", -0.2, 0.22, 0.05, 0.1, 0.1, 0.6, 0.5), box("wood", 0.25, 0.22, 0.0, 0.1, 0.1, 0.6, -0.5), box("metal", 0, 1.3, -0.1, 0.9, 0.04, 0.04)),
  cauldron: () => all(...[0, 2.1, 4.2].map((a) => box("metal", 0.4 * Math.cos(a), 0.15, 0.4 * Math.sin(a), 0.07, 0.3, 0.07)), cyl("fire", 0, 0, 0, 0.3, 0.3, 0.001, 8), cyl("metal", 0, 0.3, 0, 0.38, 0.55, 0.52, 12), cyl("metal", 0, 0.85, 0, 0.55, 0.06, 0.55, 12), cyl("moss", 0, 0.88, 0, 0.46, 0.03, 0.46, 12), box("wood", 0.3, 1.0, 0, 0.05, 0.4, 0.05, 0.4)),
  "bone-pile": () => all(...[[0, 0, 0.5, 0.4, 0.2, 0.15], [0.3, 0.1, 1.1, 0.35, 0.15, 0.12], [-0.3, 0.15, 2.0, 0.4, 0.12, 0.15], [0.05, -0.3, 0.2, 0.5, 0.14, 0.12], [-0.2, -0.1, 1.5, 0.3, 0.2, 0.12]].map(([x, z, yaw, l, h, w], i) => box("bone", x, h / 2 + (i % 2) * 0.1, z, l, h, w, yaw)), cyl("bone", 0, 0.28, 0, 0.14, 0.16, 0.12, 8), cyl("bone", 0.25, 0.12, 0.2, 0.12, 0.14, 0.1, 8), cyl("bone", -0.3, 0.1, -0.2, 0.12, 0.14, 0.1, 8)),
  "skull-shelf": () => all(box("wood", 0, 0.9, -0.12, 1.4, 1.8, 0.06), box("wood", -0.67, 0.9, 0, 0.06, 1.8, 0.3), box("wood", 0.67, 0.9, 0, 0.06, 1.8, 0.3), ...[0.03, 0.63, 1.23, 1.77].map((y) => box("wood", 0, y, 0, 1.4, 0.05, 0.3)), ...[0.08, 0.68, 1.28].flatMap((y) => [-0.5, -0.25, 0, 0.25, 0.5].map((x, i) => cyl("bone", x, y, 0.02, 0.1, 0.14 + (i % 2) * 0.03, 0.09, 7)))),
  carpet: () => all(box("cloth", 0, 0.015, 0, 1.2, 0.03, 3.6), box("gold", 0, 0.017, 1.75, 1.2, 0.034, 0.08), box("gold", 0, 0.017, -1.75, 1.2, 0.034, 0.08), box("gold", -0.56, 0.017, 0, 0.06, 0.034, 3.6), box("gold", 0.56, 0.017, 0, 0.06, 0.034, 3.6)),
  pulpit: () => all(box("stone", 0, 0.4, 0, 0.9, 0.8, 0.9), box("wood", 0, 1.1, 0, 0.8, 0.6, 0.7), box("wood", 0, 1.45, 0.05, 0.9, 0.1, 0.8), box("cloth", 0, 1.52, 0.1, 0.5, 0.04, 0.4), box("gold", 0, 0.9, 0.36, 0.3, 0.3, 0.03), box("stone", 0, 0.1, 0.6, 0.8, 0.2, 0.4)),
  "quench-trough": () => all(box("stone", 0, 0.35, 0, 1.4, 0.7, 0.7), box("ice", 0, 0.71, 0, 1.2, 0.02, 0.5), box("stone", -0.65, 0.78, 0, 0.1, 0.1, 0.7), box("stone", 0.65, 0.78, 0, 0.1, 0.1, 0.7), box("metal", 0.55, 0.45, 0.36, 0.1, 0.1, 0.03)),
  "coal-bin": () => all(box("wood", 0, 0.45, -0.5, 1.1, 0.9, 0.06), box("wood", -0.55, 0.45, 0, 0.06, 0.9, 1.0), box("wood", 0.55, 0.45, 0, 0.06, 0.9, 1.0), box("wood", 0, 0.3, 0.5, 1.1, 0.6, 0.06), cyl("metal", 0, 0.3, 0, 0.5, 0.55, 0.12, 8), box("metal", 0.2, 0.7, 0.3, 0.12, 0.1, 0.12, 0.5), box("metal", -0.25, 0.65, -0.2, 0.14, 0.1, 0.1, 1.0)),
  "tool-rack": () => all(box("wood", -0.62, 0.9, 0, 0.08, 1.8, 0.08), box("wood", 0.62, 0.9, 0, 0.08, 1.8, 0.08), box("wood", 0, 1.7, 0, 1.3, 0.08, 0.08), box("wood", 0, 1.0, 0, 1.3, 0.06, 0.06), box("wood", 0, 0.07, 0, 1.4, 0.14, 0.4), box("wood", -0.4, 1.3, 0.05, 0.04, 0.6, 0.04), box("metal", -0.4, 1.66, 0.05, 0.24, 0.12, 0.08), box("wood", 0.0, 1.35, 0.05, 0.04, 0.55, 0.04), box("metal", 0.0, 1.7, 0.05, 0.1, 0.3, 0.03), box("wood", 0.4, 1.35, 0.05, 0.04, 0.5, 0.04), box("metal", 0.4, 1.0, 0.05, 0.3, 0.05, 0.03), box("metal", -0.2, 0.7, 0.05, 0.04, 0.5, 0.03), box("metal", 0.2, 0.65, 0.05, 0.06, 0.6, 0.03)),
  "serving-counter": () => all(box("wood", 0, 0.5, 0, 2.6, 1.0, 0.8), box("stone", 0, 1.05, 0, 2.8, 0.1, 0.9), ...[-0.9, 0, 0.9].map((x) => box("wood", x, 0.5, 0.41, 0.8, 0.8, 0.02)), cyl("metal", -0.8, 1.1, 0, 0.18, 0.15, 0.2, 8), cyl("metal", 0, 1.1, 0.1, 0.15, 0.12, 0.17, 8), cyl("bone", 0.7, 1.1, -0.1, 0.12, 0.14, 0.1, 8), box("cloth", 1.0, 1.1, 0.2, 0.3, 0.03, 0.2)),
  "bookshelf-tall": () => all(box("wood", 0, 1.4, -0.12, 1.4, 2.8, 0.06), box("wood", -0.67, 1.4, 0, 0.06, 2.8, 0.3), box("wood", 0.67, 1.4, 0, 0.06, 2.8, 0.3), ...[0.03, 0.5, 0.97, 1.44, 1.91, 2.38, 2.77].map((y) => box("wood", 0, y, 0, 1.4, 0.05, 0.3)), ...[0.26, 0.73, 1.2, 1.67, 2.14, 2.58].flatMap((y, i) => [box("cloth", -0.35, y, 0.03, 0.6 - 0.04 * i, 0.36, 0.22), box("earth", 0.2, y - 0.02, 0.03, 0.5, 0.32, 0.22), box("bone", 0.52, y - 0.05, 0.03, 0.1, 0.26, 0.2)])),
  painting: () => all(box("wood", 0, 0, 0, 1.4, 1.6, 0.06), box("cloth", 0, 0.02, 0.035, 1.2, 1.4, 0.02), box("bone", 0, 0.38, 0.05, 0.3, 0.3, 0.012), box("moss", 0, -0.12, 0.05, 0.55, 0.7, 0.012), box("gold", 0, 0.62, 0.05, 0.9, 0.04, 0.012), box("gold", 0, -0.7, 0.05, 0.5, 0.1, 0.02)),
  "shield-wall": () => all(box("wood", 0, 0, 0, 1.6, 1.2, 0.06), ...[-0.5, 0, 0.5].flatMap((x, i) => [box("metal", x, 0, 0.05, 0.4, 0.55, 0.04, 0), box("gold", x, 0, 0.085, 0.12, 0.12, 0.03), box("cloth", x, 0.2 - i * 0.02, 0.075, 0.3, 0.1, 0.012)]), box("metal", 0, 0.45, 0.04, 1.4, 0.04, 0.03)),
  "key-rack": () => all(box("wood", 0, 0, 0, 0.6, 0.6, 0.04), ...[-0.2, -0.1, 0, 0.1, 0.2].flatMap((x, i) => [box("metal", x, 0.18, 0.04, 0.03, 0.04, 0.04), box(i === 2 ? "gold" : "metal", x, 0.0 - (i % 2) * 0.04, 0.045, 0.03, 0.22, 0.012), box(i === 2 ? "gold" : "metal", x, -0.15 - (i % 2) * 0.04, 0.045, 0.08, 0.05, 0.012)])),
  "jail-cell": () => all(box("stone", 0, 0.05, 0, 2.0, 0.1, 2.0), box("metal", 0, 2.3, 0.95, 2.0, 0.08, 0.08), box("metal", -0.95, 2.3, 0, 0.08, 0.08, 2.0), box("metal", 0.95, 2.3, 0, 0.08, 0.08, 2.0), box("metal", 0, 0.14, 0.95, 2.0, 0.08, 0.08), ...[-0.9, -0.6, -0.3, 0.3, 0.6, 0.9].map((x) => box("metal", x, 1.2, 0.95, 0.05, 2.2, 0.05)), ...[-0.65, -0.35, -0.05, 0.25, 0.55, 0.85].flatMap((z) => [box("metal", -0.95, 1.2, z, 0.05, 2.2, 0.05), box("metal", 0.95, 1.2, z, 0.05, 2.2, 0.05)]), box("earth", -0.4, 0.14, -0.4, 0.9, 0.08, 0.7, 0.2), cyl("metal", 0.5, 0.1, -0.5, 0.15, 0.25, 0.12, 8), box("metal", 0, 1.2, 0.97, 0.06, 0.2, 0.06)),
  "wall-coffin": () => niche(),
  "wall-coffin-high": () => niche(),
  "grand-sarcophagus": () => all(box("stone", 0, 0.075, 0, 3.6, 0.15, 2.4), box("stone", 0, 0.225, 0, 3.2, 0.15, 2.0), box("stone", 0, 0.65, 0, 2.8, 0.7, 1.3), box("gold", 0, 0.88, 0, 2.84, 0.05, 1.34), box("stone", 0, 1.0, 0, 2.9, 0.18, 1.4), box("stone", 0, 1.14, 0, 2.2, 0.1, 0.5), cyl("stone", 1.0, 1.19, 0, 0.22, 0.2, 0.2, 8), box("metal", -0.2, 1.2, 0, 1.6, 0.03, 0.07), box("gold", -0.95, 1.22, 0, 0.07, 0.04, 0.4), ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z]) => cyl("gold", x * 1.4, 0.3, z * 0.65, 0.09, 0.9, 0.07, 6))),
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
