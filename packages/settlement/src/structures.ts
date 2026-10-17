/**
 * Structure placement (spec §18): WFC over the parcel graph. Slots are
 * parcels, options are the rules' archetypes, a parcel's domain is what its
 * district allows, neighbouring parcels are the edges, and the demand is the
 * global constraints: required counts and ceilings, housing and food as
 * minimum budgets, workers as a ceiling on the labour pool. The solver's
 * seed comes from the "structures" stream, so the result is deterministic.
 */

import { solve, type WfcProblem } from "@mmo-engine/wfc";
import type { Demand } from "./demand.js";
import type { Layout } from "./layout.js";
import type { Streams } from "./rng.js";
import type { SettlementRules } from "./rules.js";

export interface Structure {
  id: string;
  archetype: string;
  parcel: string;
  district: string;
}

/** Throws the solver's WfcError when the demand cannot be met. */
export function placeStructures(layout: Layout, demand: Demand, rules: SettlementRules, rng: Streams): Structure[] {
  const ids = Object.keys(rules.archetypes);
  const arch = ids.map((id) => rules.archetypes[id]!);
  const index = new Map(ids.map((id, i) => [id, i]));
  const slotAt = new Map(layout.parcels.map((p, i) => [`${p.gx},${p.gz}`, i]));

  const edges: { a: number; b: number; rule: string }[] = [];
  layout.parcels.forEach((p, a) => {
    for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
      const b = slotAt.get(`${p.gx + dx},${p.gz + dz}`);
      if (b !== undefined) edges.push({ a, b, rule: "apart" });
    }
  });
  const forbidden = new Set(rules.forbiddenAdjacent.flatMap(([x, y]) => [`${x}|${y}`, `${y}|${x}`]));

  // A plot the layout reserved for an archetype (the watch's posts) takes only that one, and that archetype
  // stands nowhere else: its count is the reserved plots.
  const posts = new Map<string, number>();
  for (const p of layout.parcels) if (p.post) posts.set(p.post.archetype, (posts.get(p.post.archetype) ?? 0) + 1);
  const counts: NonNullable<WfcProblem["counts"]> = [
    ...Object.entries(demand.required).flatMap(([id, min]) => {
      const i = index.get(id);
      return i === undefined || posts.has(id) ? [] : [{ options: [i], min, ...(demand.max[id] !== undefined ? { max: demand.max[id] } : {}) }];
    }),
    ...[...posts].flatMap(([id, n]) => (index.has(id) ? [{ options: [index.get(id)!], min: n, max: n }] : [])),
  ];
  // Where an archetype may stand: its districts, a plot open to enough streets, a housing plot of its wealth band.
  // Open ground (parks, empty lots) stands only where the layout reserved it, so never on an unreserved plot.
  const reservedOnly = new Set([...posts.keys(), rules.openGround?.park, rules.openGround?.lot]);
  const allows = (a: (typeof arch)[number], id: string, p: Layout["parcels"][number]): boolean =>
    a.kinds.includes(p.kind) && !reservedOnly.has(id) && (a.minAccess ?? 1) <= p.access && (!a.wealth || (p.wealth !== undefined && a.wealth.includes(p.wealth)));
  const cost = (f: (a: (typeof arch)[number]) => number): number[] => arch.map(f);

  const problem: WfcProblem = {
    options: ids.map((id, i) => ({ id, weight: arch[i]!.weight })),
    slots: layout.parcels.length,
    domains: layout.parcels.map((p) => (p.post && index.has(p.post.archetype) ? [index.get(p.post.archetype)!] : ids.flatMap((id, i) => (allows(arch[i]!, id, p) ? [i] : [])))),
    edges,
    rules: { apart: (x, y) => !forbidden.has(`${x.id}|${y.id}`) },
    counts,
    budgets: [
      { cost: cost((a) => a.households), min: demand.housingDemand, ...(rules.layout.homeSpacePermille ? { max: Math.ceil((demand.housingDemand * rules.layout.homeSpacePermille) / 1000) } : {}) },
      { cost: cost((a) => a.feeds), min: demand.foodDemand },
      { cost: cost((a) => a.workers), max: demand.laborPool },
    ],
  };
  // A big town has many plots to settle: more restarts before it gives up.
  const solution = solve(problem, { seed: Math.floor(rng.get("structures").raw() * 2 ** 32) >>> 0, maxRestarts: 24 });
  return layout.parcels.map((p, i) => ({ id: p.id.replace(/^parcel/, "structure"), archetype: solution.ids[i]!, parcel: p.id, district: p.district }));
}
