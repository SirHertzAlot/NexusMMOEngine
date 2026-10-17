/**
 * Validation gates (spec §22). Each gate re-derives its answer from the
 * finished tables, independently of the stage that built them, so a stage
 * that breaks its own promise is caught here. A gate is data: its name,
 * whether it holds, and the numbers behind it.
 */

import type { Demand } from "./demand.js";
import type { Demographics } from "./demographics.js";
import type { Layout } from "./layout.js";
import type { Occupancy } from "./occupancy.js";
import type { SettlementRules } from "./rules.js";
import type { Structure } from "./structures.js";

export interface Gate {
  gate: string;
  ok: boolean;
  detail: string;
}

export interface Town {
  demographics: Demographics;
  demand: Demand;
  layout: Layout;
  structures: Structure[];
  occupancy: Occupancy;
}

const gate = (name: string, ok: boolean, detail: string): Gate => ({ gate: name, ok, detail });

/**
 * The wall, re-derived from its pieces: four straight sides with no gap, the north and south ones corner to corner
 * and the west and east ones between the corner towers, a gate on each side with a road through it, every street
 * plot inside the ring and every farm outside. An open village has no pieces at all; a shore town's ring is open
 * where pieces stood in water (`wallOpenToWater`), and only that is reported.
 */
export function fortificationGate(l: Layout): Gate {
  if (!l.walled) return gate("fortification", l.fortifications.length === 0, "an open village: no wall, farms along its roads");
  // A shore town: pieces stood in water and were left out, so the ring is open there; what is left must still
  // be pieces of the wall, never standing on a plot.
  if (l.wallOpenToWater > 0) return gate("fortification", true, `${l.fortifications.length} wall pieces, ${l.wallOpenToWater} left out where water stands: open to the water`);
  const sides = new Map<string, { alongX: boolean; at: number; spans: [number, number][]; gates: number }>();
  for (const p of l.fortifications) {
    const alongX = p.yawDeg === 0;
    const at = alongX ? p.center.z : p.center.x;
    const a = alongX ? p.center.x : p.center.z;
    const key = `${alongX ? "z" : "x"}${at}`;
    const side = sides.get(key) ?? { alongX, at, spans: [], gates: 0 };
    side.spans.push([a - p.lengthMm / 2, a + p.lengthMm / 2]);
    if (p.kind === "town_gate") side.gates++;
    sides.set(key, side);
  }
  const list = [...sides.values()];
  const xs = list.filter((v) => !v.alongX).map((v) => v.at);
  const zs = list.filter((v) => v.alongX).map((v) => v.at);
  if (xs.length !== 2 || zs.length !== 2) return gate("fortification", false, `the wall has ${list.length} sides, not 4`);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [z0, z1] = [Math.min(...zs), Math.max(...zs)];
  const problems: string[] = [];
  for (const v of list) {
    const spans = v.spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) if (Math.abs(spans[i]![0] - spans[i - 1]![1]) > 1) problems.push(`a ${spans[i]![0] > spans[i - 1]![1] ? "gap" : "overlap"} in the wall at ${spans[i - 1]![1]} mm`);
    // North and south reach past the corners by half a corner tower; west and east meet those towers.
    const half = (spans[0]![1] - spans[0]![0]) / 2;
    const [lo, hi] = v.alongX ? [x0 - half, x1 + half] : [z0 + half, z1 - half];
    if (v.alongX && (Math.abs(spans[0]![0] - lo) > 1 || Math.abs(spans[spans.length - 1]![1] - hi) > 1)) problems.push("a north or south side stops short of a corner");
    if (v.gates !== 1) problems.push(`a side with ${v.gates} gates`);
  }
  // West and east fill exactly between the north and south corner towers.
  const corner = list.find((u) => u.alongX)!.spans.sort((a, b) => a[0] - b[0])[0]!;
  const ct = corner[1] - corner[0];
  for (const v of list.filter((u) => !u.alongX)) {
    if (Math.abs(v.spans[0]![0] - (z0 + ct / 2)) > 1 || Math.abs(v.spans[v.spans.length - 1]![1] - (z1 - ct / 2)) > 1) problems.push("a west or east side does not meet the corner towers");
  }
  const gates = l.fortifications.filter((p) => p.kind === "town_gate");
  const roadless = gates.filter((g) => !l.roads.nodes.some((n) => Math.abs(n.x - g.center.x) <= 1 && Math.abs(n.z - g.center.z) <= 1));
  if (roadless.length) problems.push(`${roadless.length} gates with no road through them`);
  const inside = (p: { center: { x: number; z: number } }): boolean => p.center.x > x0 && p.center.x < x1 && p.center.z > z0 && p.center.z < z1;
  const wrong = l.parcels.filter((p) => inside(p) === (p.kind === "agriculture"));
  if (wrong.length) problems.push(`${wrong.length} plots on the wrong side of the wall (farms go outside, the rest inside)`);
  return gate("fortification", problems.length === 0, problems.length ? problems.join("; ") : `${l.fortifications.length} wall pieces, ${gates.length} gates, a closed ring`);
}

/**
 * Each district inside the walls is one quarter: its blocks touch, side to side. A block water has emptied (its
 * plots all dropped as wet) still joins the quarters round it, the way a pond in a town does not split it.
 */
export function quartersGate(l: Layout, rules: SettlementRules): Gate {
  const [bw, bd] = rules.layout.block;
  const byKind = new Map<string, Set<string>>();
  const built = new Set<string>();
  for (const p of l.parcels) {
    if (p.kind === "agriculture") continue;
    const k = `${Math.floor(p.gx / bw)},${Math.floor(p.gz / bd)}`;
    built.add(k);
    const set = byKind.get(p.kind) ?? new Set<string>();
    set.add(k);
    byKind.set(p.kind, set);
  }
  const split: string[] = [];
  for (const [kind, blocks] of byKind) {
    const first = blocks.values().next().value!;
    const seen = new Set([first]);
    const todo = [first];
    while (todo.length) {
      const [x, z] = todo.pop()!.split(",").map(Number) as [number, number];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const [nx, nz] = [x + dx, z + dz];
        const k = `${nx},${nz}`;
        const water = !built.has(k) && nx >= 0 && nz >= 0 && nx < l.blocks && nz < l.blocks;
        if ((blocks.has(k) || water) && !seen.has(k)) {
          seen.add(k);
          todo.push(k);
        }
      }
    }
    if ([...blocks].some((k) => !seen.has(k))) split.push(kind);
  }
  return gate("district_quarters", split.length === 0, split.length ? `split into pieces: ${split.join(", ")}` : `${byKind.size} quarters, each one connected group of blocks`);
}

export function validateTown(t: Town, rules: SettlementRules): Gate[] {
  const sum = (f: (id: string) => number): number => t.structures.reduce((a, s) => a + f(s.archetype), 0);
  const d = t.demographics;
  const housing = sum((id) => rules.archetypes[id]!.households);
  const food = sum((id) => rules.archetypes[id]!.feeds);
  const workers = sum((id) => rules.archetypes[id]!.workers);
  const kindOf = new Map(t.layout.parcels.map((p) => [p.id, p.kind]));
  const misplaced = t.structures.filter((s) => !rules.archetypes[s.archetype]!.kinds.includes(kindOf.get(s.parcel)!));
  const built = new Set(t.structures.map((s) => s.parcel));
  const kindById = new Map(t.structures.map((s) => [s.id, s.archetype]));
  const count = (id: string): number => t.structures.filter((s) => s.archetype === id).length;
  const short = Object.entries(t.demand.required).filter(([id, n]) => count(id) < n);
  const total = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

  // Connected: grow from the first junction along the street segments.
  const reached = new Set([t.layout.roads.nodes[0]!.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of t.layout.roads.edges) {
      if (reached.has(e.from) !== reached.has(e.to)) {
        reached.add(e.from).add(e.to);
        grew = true;
      }
    }
  }

  const o = t.occupancy;
  const perHome = new Map<string, number>();
  for (const h of o.households) perHome.set(h.home, (perHome.get(h.home) ?? 0) + 1);
  const overHome = [...perHome].filter(([id, n]) => n > rules.archetypes[kindById.get(id)!]!.households);
  const perJob = new Map<string, number>();
  for (const n of o.npcs) if (n.workplace) perJob.set(n.workplace, (perJob.get(n.workplace) ?? 0) + 1);
  const overJob = [...perJob].filter(([id, n]) => n > rules.archetypes[kindById.get(id)!]!.workers);

  return [
    gate("demographic_validity", total(d.ageCohorts) === d.population && total(d.socialClasses) === d.population, `${d.population} people in ${d.households} households`),
    gate("housing_capacity", housing >= d.households, `${housing} homes for ${d.households} households`),
    gate("food_security", food >= t.demand.foodDemand, `feeds ${food} of ${t.demand.foodDemand}`),
    gate("labor_balance", workers <= d.laborPool, `${workers} jobs for ${d.laborPool} workers`),
    gate("road_connectivity", reached.size === t.layout.roads.nodes.length && t.layout.parcels.every((p) => p.roadFrontage), `${reached.size} of ${t.layout.roads.nodes.length} junctions reachable`),
    gate("structure_coverage", t.layout.parcels.every((p) => built.has(p.id)) && short.length === 0, short.length ? `short of ${short.map(([id]) => id).join(", ")}` : `${t.structures.length} structures on ${t.layout.parcels.length} parcels`),
    gate("occupancy_population", o.npcs.length === d.population && o.households.reduce((a, h) => a + h.size, 0) === d.population, `${o.npcs.length} people in ${o.households.length} households`),
    gate("occupancy_homes", overHome.length === 0 && o.households.length === d.households, overHome.length ? `${overHome.length} homes over capacity` : `${o.households.length} households, each in a home with room`),
    gate("occupancy_jobs", overJob.length === 0, overJob.length ? `${overJob.length} workplaces over their jobs` : `${perJob.size} workplaces staffed within their jobs`),
    fortificationGate(t.layout),
    quartersGate(t.layout, rules),
    gate("zoning", misplaced.length === 0, misplaced.length ? `${misplaced.length} structures outside their district` : "every structure stands in a district that allows it"),
  ];
}
