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
  /** Their household and its home; null for the homeless (rules.homeless). */
  household: string | null;
  home: string | null;
  /** Where a homeless person sleeps (a hospital, monastery or church; absent: rough, where the town has none). */
  shelter?: string;
  cohort: string;
  class: string;
  role: string;
  /** The structure they work in (absent: not employed). */
  workplace?: string;
  /** The profession they are a master of (rules.mastery): players can learn from them. */
  mastery?: string;
  /** A grand master of it: pupils come from afar to learn from them. */
  grandMaster?: boolean;
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

export function occupy(settlement: string, d: Demographics, structures: readonly Structure[], rules: SettlementRules, rng: Streams, grandMasters: Record<string, number> = {}): Occupancy {
  const r = rng.get("population");
  const byId = [...structures].sort((a, b) => (a.id < b.id ? -1 : 1));
  const archetypeOf = new Map(byId.map((s) => [s.id, rules.archetypes[s.archetype]!]));
  const structureArchetype = new Map(byId.map((s) => [s.id, s.archetype]));

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
  const housed = d.population - d.homeless;
  const base = Math.floor(housed / d.households);
  const extra = housed - base * d.households;
  const households: Household[] = Array.from({ length: d.households }, (_, i) => ({ id: entityId("household", settlement, i), home: homes[i]!, size: base + (i < extra ? 1 : 0) }));

  // People: an adult heads each household; the rest are dealt out shuffled. The homeless are taken from the
  // rest first, grown people before children (the orphans among them only when there are not enough).
  const labels = Object.entries(d.ageCohorts).flatMap(([cohort, n]) => Array.from({ length: n }, () => cohort));
  const adults = labels.filter((c) => c === "adult");
  if (adults.length < d.households) throw new Error(`${d.households} households but only ${adults.length} adults`);
  const shuffled = shuffle([...adults.slice(d.households), ...labels.filter((c) => c !== "adult")], r);
  const grown = shuffled.filter((c) => c !== "child");
  const homelessCohorts = [...grown, ...shuffled.filter((c) => c === "child")].slice(0, d.homeless);
  const taken = new Map<string, number>();
  for (const c of homelessCohorts) taken.set(c, (taken.get(c) ?? 0) + 1);
  const rest = shuffled.filter((c) => {
    const n = taken.get(c) ?? 0;
    if (n === 0) return true;
    taken.set(c, n - 1);
    return false;
  });
  // Classes: the homeless are the poorest (peasants, as far as there are), the housed take the rest shuffled.
  const classLabels = Object.entries(d.socialClasses).flatMap(([c, n]) => Array.from({ length: n }, () => c));
  const poorest = "peasant";
  const homelessClasses = [...classLabels.filter((c) => c === poorest), ...classLabels.filter((c) => c !== poorest)].slice(0, d.homeless);
  const left = new Map<string, number>();
  for (const c of homelessClasses) left.set(c, (left.get(c) ?? 0) + 1);
  const classes = shuffle(
    classLabels.filter((c) => {
      const n = left.get(c) ?? 0;
      if (n === 0) return true;
      left.set(c, n - 1);
      return false;
    }),
    r,
  );
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
  // The homeless sleep at the shelters, dealt round them in turn; with none, rough.
  const shelterIds = new Set(rules.homeless?.shelters ?? []);
  const shelters = shuffle(byId.filter((s) => shelterIds.has(s.archetype)).map((s) => s.id), r);
  homelessCohorts.forEach((cohort, i) =>
    npcs.push({ id: entityId("npc", settlement, d.households, i), household: null, home: null, ...(shelters.length ? { shelter: shelters[i % shelters.length]! } : {}), cohort, class: homelessClasses[i]!, role: "" }),
  );

  // Jobs: working-age people, shuffled, fill the jobs in structure order.
  const jobs = slots(byId, (a) => rules.archetypes[a]!.workers);
  const eligible = shuffle(npcs.filter((n) => WORKING.has(n.cohort)), r);
  jobs.slice(0, eligible.length).forEach((structure, i) => (eligible[i]!.workplace = structure));
  // The first worker of each master workplace is its master; the others are their apprentices.
  const professionOf = new Map(Object.entries(rules.mastery?.professions ?? {}).map(([name, p]) => [p.master, name]));
  const mastered = new Set<string>();
  for (const n of eligible) {
    const s = n.workplace;
    const name = s ? professionOf.get(structureArchetype.get(s)!) : undefined;
    if (s && name && !mastered.has(s)) {
      mastered.add(s);
      n.mastery = name;
      // The first masters of a profession at work are its grand masters, as many as the town has.
      if ((grandMasters[name] ?? 0) > 0) {
        grandMasters = { ...grandMasters, [name]: grandMasters[name]! - 1 };
        n.grandMaster = true;
      }
    }
  }
  // The homeless without work beg; those with work are day labourers at it, like anyone.
  for (const n of npcs) n.role = n.workplace ? archetypeOf.get(n.workplace)!.role : n.home === null ? (n.cohort === "child" ? "orphan" : "beggar") : n.cohort === "child" ? "child" : n.cohort === "elder" ? "elder" : "resident";
  for (const n of npcs) if (n.grandMaster) n.role = `grand ${n.role}`;
  // The others at a master's workplace are apprentices of the ordinary trade.
  for (const n of npcs) {
    const name = n.workplace && !n.mastery ? professionOf.get(structureArchetype.get(n.workplace)!) : undefined;
    if (name) n.role = `apprentice ${rules.archetypes[rules.mastery!.professions[name]!.archetype]?.role ?? name}`;
  }

  const shops: Shop[] = byId
    .filter((s) => archetypeOf.get(s.id)!.shop)
    .map((s, i) => ({ id: entityId("shop", settlement, i), structure: s.id, owner: npcs.find((n) => n.workplace === s.id)?.id ?? null }));
  return { households, npcs, shops };
}
