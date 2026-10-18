/**
 * What players gather around a town (rules.industry.resources): its land's resources as objects in the world. Tree
 * stands, ore veins and fishing spots stand in the open ground round the town, clear of its plots, fields and roads,
 * so many for each of its industry's workplaces and a few of every other resource rich enough near it. Each is of one
 * of its industry's products near the town (the rarer tiers fewer, the "resources" stream picks; the town's first node of
 * its own industry is always of what it is known for), holds the gathers the
 * town's stock has left, and says how long it takes to come back. Positions are in mm like the layout.
 */

import { entityId } from "./ids.js";
import { nearProducts, type Land, type TownIndustry } from "./industry.js";
import type { Layout } from "./layout.js";
import type { Streams } from "./rng.js";
import { INDUSTRIES, type IndustryId, type SettlementRules } from "./rules.js";
import type { Structure } from "./structures.js";

export interface ResourceNode {
  id: string;
  industry: IndustryId;
  /** The node's kind (tree_stand, ore_vein, fishing_spot) and the skill that gathers it. */
  kind: string;
  skill: string;
  /** The crafting material it gives, and its tier. */
  material: string;
  tier: number;
  center: { x: number; z: number };
  sizeMm: [number, number];
  heightMm: number;
  /** Gathers left in it, and the hours it takes to come back once worked out (0: never). */
  stock: number;
  regrowHours: number;
}

type Box = { x0: number; x1: number; z0: number; z1: number };
const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;
const boxAt = (x: number, z: number, w: number, d: number, pad = 0): Box => ({ x0: x - w / 2 - pad, x1: x + w / 2 + pad, z0: z - d / 2 - pad, z1: z + d / 2 + pad });

/** The ground the town has taken: its plots, fields, roads and wall, mm (the town between them: `placeResources`). */
export function takenGround(layout: Layout, parcelMm: [number, number]): Box[] {
  const [pw, pd] = parcelMm;
  const out: Box[] = [];
  for (const p of layout.parcels) {
    const [w, d] = p.facing % 180 === 0 ? [pw, pd] : [pd, pw];
    out.push(boxAt(p.center.x, p.center.z, w, d));
    if (p.holding) out.push(boxAt(p.holding.center.x, p.holding.center.z, p.holding.sizeXMm, p.holding.sizeZMm));
  }
  const at = new Map(layout.roads.nodes.map((n) => [n.id, n]));
  for (const e of layout.roads.edges) {
    const a = at.get(e.from)!;
    const b = at.get(e.to)!;
    out.push({ x0: Math.min(a.x, b.x) - e.widthMm / 2, x1: Math.max(a.x, b.x) + e.widthMm / 2, z0: Math.min(a.z, b.z) - e.widthMm / 2, z1: Math.max(a.z, b.z) + e.widthMm / 2 });
  }
  for (const w of layout.fortifications) {
    const [x, z] = w.yawDeg % 180 === 0 ? [w.lengthMm, w.thicknessMm] : [w.thicknessMm, w.lengthMm];
    out.push(boxAt(w.center.x, w.center.z, x, z));
  }
  return out;
}

/**
 * The town's resource nodes: none without its land or resource rules. `dry` tells whether a point (mm, in the layout's
 * frame) is dry land; without it every point is, and no fishing spot is placed (the water is not known).
 */
export function placeResources(settlement: string, layout: Layout, structures: readonly Structure[], industry: TownIndustry | null, land: Land | null, rules: SettlementRules, rng: Streams, parcelMm: [number, number], dry?: (xMm: number, zMm: number) => boolean): ResourceNode[] {
  const ir = rules.industry;
  const rr = ir?.resources;
  if (!ir || !rr || !land || !industry) return [];
  // How many of each: the town's own industry by its workplaces, the others by how rich they are near it.
  const want = new Map<IndustryId, number>();
  for (const id of INDUSTRIES) {
    if (!rr.nodes[id]) continue;
    const n = id === industry.primary
      ? structures.filter((s) => s.archetype === ir.industries[id].workplace).length * rr.perWorkplace
      : industry.resources[id] >= ir.minAbundancePermille ? Math.round((rr.nearby * industry.resources[id]) / 1000) : 0;
    if (n > 0) want.set(id, n);
  }
  if (want.size === 0) return [];
  const taken = takenGround(layout, parcelMm);
  // The band is measured from the town itself (its street plots and wall), not its farms and craft lanes.
  const core = takenGround({ ...layout, parcels: layout.parcels.filter((p) => p.kind !== "agriculture" && p.kind !== "manufacturing"), roads: { nodes: [], edges: [] } }, parcelMm);
  const bounds = core.reduce((b, t) => ({ x0: Math.min(b.x0, t.x0), x1: Math.max(b.x1, t.x1), z0: Math.min(b.z0, t.z0), z1: Math.max(b.z1, t.z1) }), { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity });
  const c = { x: (bounds.x0 + bounds.x1) / 2, z: (bounds.z0 + bounds.z1) / 2 };
  // Nothing grows inside the town (its square and streets are no one's to gather from): the town's whole box is taken.
  const edge = rr.spacingMm;
  taken.push({ x0: bounds.x0 - edge, x1: bounds.x1 + edge, z0: bounds.z0 - edge, z1: bounds.z1 + edge });
  // Candidate spots on a jittered grid over the town and the band round it, nearest the town first.
  const pick = rng.get("resources");
  const s = rr.spacingMm;
  const jitter = s / 4;
  const reach = Math.max(bounds.x1 - c.x, bounds.z1 - c.z) + rr.bandMm;
  const spots: { x: number; z: number; d: number }[] = [];
  for (let gz = Math.ceil(-reach / s); gz * s <= reach; gz++) {
    for (let gx = Math.ceil(-reach / s); gx * s <= reach; gx++) {
      const x = c.x + gx * s + (pick.raw() * 2 - 1) * jitter;
      const z = c.z + gz * s + (pick.raw() * 2 - 1) * jitter;
      spots.push({ x: Math.round(x), z: Math.round(z), d: Math.hypot(x - c.x, z - c.z) });
    }
  }
  spots.sort((a, b) => a.d - b.d || a.z - b.z || a.x - b.x);
  const used = new Set<number>();
  const out: Omit<ResourceNode, "id">[] = [];
  for (const id of INDUSTRIES) {
    const n = want.get(id);
    if (!n) continue;
    const spec = rr.nodes[id]!;
    const left = 1000 - Math.min(1000, Math.max(0, land.depletedPermille?.[id] ?? 0));
    const stock = Math.round((spec.stock * left) / 1000);
    if (stock <= 0) continue;
    const onWater = id === "fishing";
    if (onWater && !dry) continue;
    const products = nearProducts(land, id, rules);
    const choices = products.length ? products : ir.industries[id].products.slice(0, 1);
    const weights = choices.map((p) => 1 / p.tier);
    const total = weights.reduce((a, b) => a + b, 0);
    let placed = 0;
    for (let i = 0; i < spots.length && placed < n; i++) {
      if (used.has(i)) continue;
      const sp = spots[i]!;
      if (sp.d > reach) break;
      const box = boxAt(sp.x, sp.z, spec.sizeMm[0], spec.sizeMm[1], 2000);
      if (taken.some((t) => overlaps(t, box))) continue;
      const wet = dry ? !dry(sp.x, sp.z) : false;
      if (wet !== onWater) continue;
      // A fishing spot is off the shore: dry land within a spacing of it.
      if (onWater && ![[s, 0], [-s, 0], [0, s], [0, -s]].some(([dx, dz]) => dry!(sp.x + dx!, sp.z + dz!))) continue;
      used.add(i);
      let r = pick.raw() * total;
      // The town's first node of its own industry is of what it is known for: there is always some to find.
      const signature = placed === 0 && id === industry.primary ? choices.find((c) => c.material === industry.product?.material) : undefined;
      const p = signature ?? choices.find((_, k) => (r -= weights[k]!) < 0) ?? choices[choices.length - 1]!;
      out.push({ industry: id, kind: spec.kind, skill: spec.skill, material: p.material, tier: p.tier, center: { x: sp.x, z: sp.z }, sizeMm: [spec.sizeMm[0], spec.sizeMm[1]], heightMm: spec.sizeMm[2], stock, regrowHours: spec.regrowHours });
      placed++;
    }
  }
  return out.map((r, i) => ({ id: entityId("resource", settlement, i), ...r }));
}
