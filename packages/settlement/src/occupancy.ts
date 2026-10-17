/**
 * The occupancy baker (spec §19 to §20): who lives and works where. People
 * are dealt into households (every household gets an adult first), households
 * into the homes the structures offer, and working-age people into jobs, so
 * every total ties back to the demographics and no structure holds more than
 * it is built for. All draws come from the "population" stream.
 */

import type { Demographics } from "./demographics.js";
import { entityId } from "./ids.js";
import { shuffle, type Streams } from "./rng.js";
import type { SettlementRules } from "./rules.js";
import type { Structure } from "./structures.js";

export interface Household {
  id: string;
  home: string;
  size: number;
}

export interface Npc {
  id: string;
  household: string;
  home: string;
  cohort: string;
  class: string;
  role: string;
  /** The structure they work in (absent: not employed). */
  workplace?: string;
}

export interface Shop {
  id: string;
  structure: string;
  /** The worker who keeps it (null: no one was free to). */
  owner: string | null;
}

export interface Occupancy {
  households: Household[];
  npcs: Npc[];
  shops: Shop[];
}

const WORKING = new Set(["adult", "adolescent"]);

/** `capacity(archetype)` slots per structure, in structure order. */
function slots(structures: readonly Structure[], capacity: (archetype: string) => number): string[] {
  return structures.flatMap((s) => Array.from({ length: capacity(s.archetype) }, () => s.id));
}

export function occupy(settlement: string, d: Demographics, structures: readonly Structure[], rules: SettlementRules, rng: Streams): Occupancy {
  const r = rng.get("population");
  const byId = [...structures].sort((a, b) => (a.id < b.id ? -1 : 1));
  const archetypeOf = new Map(byId.map((s) => [s.id, rules.archetypes[s.archetype]!]));

  // Households, each in one home slot. The crowded homes of the poor (built for three families or more) fill
  // first; the others a family at a time, every home taking one before any takes a second, so shared homes are
  // common and no home stands empty while another is shared.
  const cap = (a: string): number => rules.archetypes[a]!.households;
  const rounds = Math.max(0, ...byId.map((s) => cap(s.archetype)));
  const homes = [
    ...shuffle(slots(byId, (a) => (cap(a) >= 3 ? cap(a) : 0)), r),
    ...Array.from({ length: rounds }, (_, round) => shuffle(slots(byId, (a) => (cap(a) < 3 && cap(a) > round ? 1 : 0)), r)).flat(),
  ];
  if (homes.length < d.households) throw new Error(`${d.households} households but only ${homes.length} homes`);
  const base = Math.floor(d.population / d.households);
  const extra = d.population - base * d.households;
  const households: Household[] = Array.from({ length: d.households }, (_, i) => ({ id: entityId("household", settlement, i), home: homes[i]!, size: base + (i < extra ? 1 : 0) }));

  // People: an adult heads each household; the rest are dealt out shuffled.
  const labels = Object.entries(d.ageCohorts).flatMap(([cohort, n]) => Array.from({ length: n }, () => cohort));
  const adults = labels.filter((c) => c === "adult");
  if (adults.length < d.households) throw new Error(`${d.households} households but only ${adults.length} adults`);
  const rest = shuffle([...adults.slice(d.households), ...labels.filter((c) => c !== "adult")], r);
  const classes = shuffle(Object.entries(d.socialClasses).flatMap(([c, n]) => Array.from({ length: n }, () => c)), r);
  let next = 0;
  const npcs: Npc[] = households.flatMap((h, hi) =>
    Array.from({ length: h.size }, (_, mi) => ({
      id: entityId("npc", settlement, hi, mi),
      household: h.id,
      home: h.home,
      cohort: mi === 0 ? "adult" : rest[next++]!,
      class: "",
      role: "",
    })),
  );
  npcs.forEach((n, i) => (n.class = classes[i]!));

  // Jobs: working-age people, shuffled, fill the jobs in structure order.
  const jobs = slots(byId, (a) => rules.archetypes[a]!.workers);
  const eligible = shuffle(npcs.filter((n) => WORKING.has(n.cohort)), r);
  jobs.slice(0, eligible.length).forEach((structure, i) => (eligible[i]!.workplace = structure));
  for (const n of npcs) n.role = n.workplace ? archetypeOf.get(n.workplace)!.role : n.cohort === "child" ? "child" : n.cohort === "elder" ? "elder" : "resident";

  const shops: Shop[] = byId
    .filter((s) => archetypeOf.get(s.id)!.shop)
    .map((s, i) => ({ id: entityId("shop", settlement, i), structure: s.id, owner: npcs.find((n) => n.workplace === s.id)?.id ?? null }));
  return { households, npcs, shops };
}
