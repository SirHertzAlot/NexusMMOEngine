/**
 * Street furniture and dressing (rules.props): lamps along the streets, benches, a fountain and statues in the
 * square, benches and a fountain or statue in each park, barrels and crates at the stores' doors, planters at the
 * well-off homes, and the raised terraces (with their stairs) the grand buildings stand on. Placed from the finished
 * layout, structures and people, in mm like the layout; the "props" stream picks only what each park gets.
 */

import { entityId } from "./ids.js";
import type { Facing, Layout, Parcel } from "./layout.js";
import type { Occupancy } from "./occupancy.js";
import type { Streams } from "./rng.js";
import type { PropKind, SettlementRules } from "./rules.js";
import type { Structure } from "./structures.js";

/** Space left between a building and its parcel's edge, each side, mm (the scene builds to it). */
export const BUILDING_MARGIN_MM = 1000;

export interface Prop {
  id: string;
  kind: PropKind | "terrace" | "stairs";
  center: { x: number; z: number };
  /** Which way it faces (a bench's seat, a lamp's arm, a statue's front, stairs going up), as a building's facing. */
  yawDeg: Facing;
  /** Width along its front and depth away from it, mm. */
  sizeMm: [number, number];
  /** Its height, mm (a terrace's top; stairs: the terrace they climb to). */
  heightMm: number;
  /** The plot it belongs to (a terrace, its stairs, what stands at a door or in a park). */
  parcel?: string;
  /** How high it stands, mm: on its plot's terrace, else 0 (left out). */
  yMm?: number;
  /** A statue's grand master (an NPC id). */
  honours?: string;
}

/** The unit vector a facing points along, and the one along its front (to its right, looking out). */
function axes(f: Facing): { out: [number, number]; along: [number, number] } {
  const out: [number, number] = f === 0 ? [0, 1] : f === 90 ? [1, 0] : f === 180 ? [0, -1] : [-1, 0];
  return { out, along: [out[1], -out[0]] };
}

/** A prop's footprint as an x/z box, mm. */
export function propBox(p: Pick<Prop, "center" | "yawDeg" | "sizeMm">): { x0: number; x1: number; z0: number; z1: number } {
  const [w, d] = p.yawDeg % 180 === 0 ? p.sizeMm : [p.sizeMm[1], p.sizeMm[0]];
  return { x0: p.center.x - w / 2, x1: p.center.x + w / 2, z0: p.center.z - d / 2, z1: p.center.z + d / 2 };
}

export function placeProps(settlement: string, layout: Layout, structures: readonly Structure[], occupancy: Occupancy, population: number, rules: SettlementRules, rng: Streams, parcelMm: [number, number], scale = 1): Prop[] {
  const r = rules.props;
  if (!r) return [];
  const [pw, pd] = parcelMm;
  const size = (k: PropKind): [number, number] => [r.sizesMm[k][0], r.sizesMm[k][1]];
  const height = (k: PropKind): number => r.sizesMm[k][2];
  const out: Omit<Prop, "id">[] = [];
  const put = (kind: PropKind, x: number, z: number, yawDeg: Facing, extra: Partial<Prop> = {}): void => {
    out.push({ kind, center: { x: Math.round(x), z: Math.round(z) }, yawDeg, sizeMm: size(kind), heightMm: height(kind), ...extra });
  };
  const built = new Map(structures.map((s) => [s.parcel, s.archetype]));
  const terraced = new Set(r.terraces.archetypes);
  const t = r.terraces;
  const steps = Math.max(0, Math.ceil(t.heightMm / t.stepRiseMm) - 1);
  const stairsDeep = steps * t.stepTreadMm;
  const inside = (p: Parcel): boolean => p.kind !== "agriculture" && p.kind !== "manufacturing";

  // Terraces: the plot raised whole, its stairs running out into the street before the door.
  const raised = new Set<string>();
  for (const p of layout.parcels) {
    if (!terraced.has(built.get(p.id) ?? "")) continue;
    const { out: o } = axes(p.facing);
    raised.add(p.id);
    out.push({ kind: "terrace", center: p.center, yawDeg: p.facing, sizeMm: [pw, pd], heightMm: t.heightMm, parcel: p.id });
    if (steps > 0) {
      const front = pd / 2 + stairsDeep / 2;
      out.push({ kind: "stairs", center: { x: p.center.x + o[0] * front, z: p.center.z + o[1] * front }, yawDeg: p.facing, sizeMm: [t.stairsWidthMm, stairsDeep], heightMm: t.heightMm, parcel: p.id });
    }
  }

  // Lamps: at the plots' boundaries along the streets (the plots inside face north or south), every
  // `lampEveryPlots` plots, the two sides of a street staggered.
  for (const p of layout.parcels) {
    if (!inside(p) || (p.gx + (p.facing === 0 ? 1 : 0)) % r.lampEveryPlots !== 0) continue;
    const z = p.facing === 0 ? p.center.z + pd / 2 + r.lampInsetMm : p.center.z - pd / 2 - r.lampInsetMm;
    put("street_lamp", p.center.x - pw / 2, z, p.facing);
  }

  // The square: a lamp at each corner, benches round its edge facing in, a fountain and statues about the well.
  const sq = layout.square;
  if (sq) {
    const hw = sq.widthMm / 2;
    const hd = sq.depthMm / 2;
    const c = sq.center;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) put("street_lamp", c.x + sx * (hw + r.lampInsetMm), c.z + sz * (hd + r.lampInsetMm), sz < 0 ? 180 : 0);
    const inset = r.squareBenchInsetMm;
    const row = (length: number): number[] => {
      const n = Math.max(0, Math.floor((length - 2 * inset) / r.squareBenchSpacingMm));
      return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * r.squareBenchSpacingMm);
    };
    for (const a of row(sq.widthMm)) {
      put("bench", c.x + a, c.z - hd + inset, 0);
      put("bench", c.x + a, c.z + hd - inset, 180);
    }
    for (const a of row(sq.depthMm)) {
      put("bench", c.x - hw + inset, c.z + a, 90);
      put("bench", c.x + hw - inset, c.z + a, 270);
    }
    // Spots about the well: the fountain east of it, the town's statue west, the grand masters' north and south, then the corners.
    const spots: [number, number][] = [[1, 0], [-1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]].map(([u, v]) => [c.x + (u! * hw) / 2, c.z + (v! * hd) / 2]);
    if (population >= r.fountainMinPopulation) put("fountain", ...spots[0]!, 0);
    if (population >= r.statueMinPopulation) put("statue", ...spots[1]!, 90);
    const grand = occupancy.npcs.filter((n) => n.grandMaster).map((n) => n.id).sort();
    grand.slice(0, spots.length - 2).forEach((id, i) => {
      const [x, z] = spots[i + 2]!;
      put("statue", x, z, z < c.z ? 0 : 180, { honours: id });
    });
  }

  // Parks: benches facing a fountain or a statue in the middle.
  const pick = rng.get("props");
  for (const p of layout.parcels) {
    if (built.get(p.id) !== rules.openGround?.park) continue;
    const feature: PropKind = pick.raw() < 0.5 ? "fountain" : "statue";
    put(feature, p.center.x, p.center.z, p.facing, { parcel: p.id });
    const { out: o, along } = axes(p.facing);
    const deep = pd / 4;
    const side = pw / 4;
    const seats: [number, number, Facing][] = [
      [o[0] * deep, o[1] * deep, ((p.facing + 180) % 360) as Facing],
      [-o[0] * deep, -o[1] * deep, p.facing],
      [along[0] * side, along[1] * side, ((p.facing + 270) % 360) as Facing],
      [-along[0] * side, -along[1] * side, ((p.facing + 90) % 360) as Facing],
    ];
    for (const [dx, dz, yaw] of seats.slice(0, r.parkBenches)) put("bench", p.center.x + dx, p.center.z + dz, yaw, { parcel: p.id });
  }

  // At the doors: barrels and a crate at the stores, planters at the well-off homes; in the front margin (on the terrace if raised).
  for (const p of layout.parcels) {
    const archetype = built.get(p.id);
    if (!archetype) continue;
    const store = r.stores.includes(archetype);
    const planted = !!p.wealth && r.planters.includes(p.wealth) && rules.archetypes[archetype]!.households > 0;
    if (!store && !planted) continue;
    const { out: o, along } = axes(p.facing);
    const front = pd / 2 - BUILDING_MARGIN_MM / 2;
    const at = (a: number): [number, number] => [p.center.x + o[0] * front + along[0] * a * scale, p.center.z + o[1] * front + along[1] * a * scale];
    const on = raised.has(p.id) ? { yMm: t.heightMm } : {};
    if (store) {
      put("barrel", ...at(3000), p.facing, { parcel: p.id, ...on });
      put("crate", ...at(-3000), p.facing, { parcel: p.id, ...on });
    } else {
      put("planter", ...at(2000), p.facing, { parcel: p.id, ...on });
      put("planter", ...at(-2000), p.facing, { parcel: p.id, ...on });
    }
  }

  return out.map((p, i) => ({ id: entityId("prop", settlement, i), ...p }));
}
