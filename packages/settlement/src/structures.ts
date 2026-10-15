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

  const counts: NonNullable<WfcProblem["counts"]> = Object.entries(demand.required).flatMap(([id, min]) => {
    const i = index.get(id);
    return i === undefined ? [] : [{ options: [i], min, ...(demand.max[id] !== undefined ? { max: demand.max[id] } : {}) }];
  });
  const cost = (f: (a: (typeof arch)[number]) => number): number[] => arch.map(f);

  const problem: WfcProblem = {
    options: ids.map((id, i) => ({ id, weight: arch[i]!.weight })),
    slots: layout.parcels.length,
    domains: layout.parcels.map((p) => ids.flatMap((_id, i) => (arch[i]!.kinds.includes(p.kind) ? [i] : []))),
    edges,
    rules: { apart: (x, y) => !forbidden.has(`${x.id}|${y.id}`) },
    counts,
    budgets: [
      { cost: cost((a) => a.households), min: demand.housingDemand },
      { cost: cost((a) => a.feeds), min: demand.foodDemand },
      { cost: cost((a) => a.workers), max: demand.laborPool },
    ],
  };
  const solution = solve(problem, { seed: Math.floor(rng.get("structures").raw() * 2 ** 32) >>> 0 });
  return layout.parcels.map((p, i) => ({ id: p.id.replace(/^parcel/, "structure"), archetype: solution.ids[i]!, parcel: p.id, district: p.district }));
}
