/**
 * Validation gates (spec §22). Each gate re-derives its answer from the
 * finished tables, independently of the stage that built them, so a stage
 * that breaks its own promise is caught here. A gate is data: its name,
 * whether it holds, and the numbers behind it.
 */

import type { Demand } from "./demand.js";
import type { Demographics } from "./demographics.js";
import type { Layout } from "./layout.js";
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
}

const gate = (name: string, ok: boolean, detail: string): Gate => ({ gate: name, ok, detail });

export function validateTown(t: Town, rules: SettlementRules): Gate[] {
  const sum = (f: (id: string) => number): number => t.structures.reduce((a, s) => a + f(s.archetype), 0);
  const d = t.demographics;
  const housing = sum((id) => rules.archetypes[id]!.households);
  const food = sum((id) => rules.archetypes[id]!.feeds);
  const workers = sum((id) => rules.archetypes[id]!.workers);
  const kindOf = new Map(t.layout.parcels.map((p) => [p.id, p.kind]));
  const misplaced = t.structures.filter((s) => !rules.archetypes[s.archetype]!.kinds.includes(kindOf.get(s.parcel)!));
  const built = new Set(t.structures.map((s) => s.parcel));
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

  return [
    gate("demographic_validity", total(d.ageCohorts) === d.population && total(d.socialClasses) === d.population, `${d.population} people in ${d.households} households`),
    gate("housing_capacity", housing >= d.households, `${housing} homes for ${d.households} households`),
    gate("food_security", food >= t.demand.foodDemand, `feeds ${food} of ${t.demand.foodDemand}`),
    gate("labor_balance", workers <= d.laborPool, `${workers} jobs for ${d.laborPool} workers`),
    gate("road_connectivity", reached.size === t.layout.roads.nodes.length && t.layout.parcels.every((p) => p.roadFrontage), `${reached.size} of ${t.layout.roads.nodes.length} junctions reachable`),
    gate("structure_coverage", t.layout.parcels.every((p) => built.has(p.id)) && short.length === 0, short.length ? `short of ${short.map(([id]) => id).join(", ")}` : `${t.structures.length} structures on ${t.layout.parcels.length} parcels`),
    gate("zoning", misplaced.length === 0, misplaced.length ? `${misplaced.length} structures outside their district` : "every structure stands in a district that allows it"),
  ];
}
