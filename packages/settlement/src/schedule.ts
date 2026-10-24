/**
 * A resident's day (SG3b, R1): where a baked npc is for a given time of day. A pure function of the
 * npc, the clock and the town's structures, so the same people are in the same places on every
 * boot and for every player, and tests need no engine.
 *
 * Workers keep their hours at their workplace (night at home, an evening at the tavern for a seeded
 * share of adults); everyone else is at home at night and about the square by day. Each npc's block
 * edges move by up to half an hour, seeded by their id, so a town does not change shift in lockstep.
 * "Indoors" means the resident has no entity (buildings are boxes): the home at night, the tavern,
 * a workshop interior. A market stall, a field, a yard or the square is outdoors.
 */

import type { Npc } from "./occupancy.js";

/** The anchor of someone about the town square (not a structure). */
export const SQUARE = "@square";

/** Where a resident is: an anchor (a structure id, or SQUARE), whether it is outdoors there, and what they are doing. */
export interface Placement {
  anchor: string;
  outdoors: boolean;
  activity: "sleep" | "work" | "tavern" | "idle";
}

/** What the schedule needs to know of the town. */
export interface TownView {
  /** Archetype of a structure id (house, bakery, market...). */
  archetypeOf(structure: string): string | undefined;
  /** The tavern or inn nearest to a home (undefined: the town has none). */
  tavernNear(home: string | null): string | undefined;
}

/** Archetypes where the work is done out in the open, or the keeper stands at the front. */
export const OUTDOOR_ARCHETYPES: ReadonlySet<string> = new Set([
  "market", "farmstead", "master_farmstead", "sawmill", "fishery", "master_fishery", "mine", "guardhouse",
  "watch_hq", "barracks", "guard_outpost", "farm_field", "ranch_pen", "park", "garden", "churchyard", "smithy", "master_smithy", "shop", "bakery", "master_bakery", "mill",
]);

/** A stable 32-bit hash of a string (FNV-1a). */
export function hashOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const WORKING = new Set(["adult", "adolescent"]);

/** Hours in a day block: [from, to) on a 24 h clock, wrapping past midnight when from > to. */
function within(h: number, from: number, to: number): boolean {
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

/**
 * Where `npc` is at `timeOfDay` (0..1, 0 midnight). `town` says what its structures are.
 * A resident whose anchor is unknown to the town falls back to the square.
 */
export function scheduleAt(npc: Npc, timeOfDay: number, town: TownView): Placement {
  const seed = hashOf(npc.id);
  // Block edges shift by up to +-30 minutes, by id.
  const jitter = ((seed % 61) - 30) / 60;
  const hour = (((timeOfDay * 24 + jitter) % 24) + 24) % 24;
  const home = npc.home ?? npc.shelter ?? null;
  const homeAt = (): Placement => (home ? { anchor: home, outdoors: false, activity: "sleep" } : { anchor: SQUARE, outdoors: true, activity: "sleep" });
  const at = (anchor: string | undefined, activity: Placement["activity"]): Placement => {
    if (!anchor || (anchor !== SQUARE && town.archetypeOf(anchor) === undefined)) return { anchor: SQUARE, outdoors: true, activity };
    return { anchor, outdoors: anchor === SQUARE || OUTDOOR_ARCHETYPES.has(town.archetypeOf(anchor)!), activity };
  };

  if (npc.workplace && WORKING.has(npc.cohort)) {
    const keeper = (town.archetypeOf(npc.workplace) ?? "").match(/^(tavern|inn)$/) !== null;
    // Tavern and inn keepers work the afternoon and evening, the rest the day.
    if (keeper ? within(hour, 12, 24) : within(hour, 8, 17)) return at(npc.workplace, "work");
    if (!keeper && within(hour, 17, 21) && seed % 100 < 40) {
      const tavern = town.tavernNear(npc.home);
      if (tavern) return { anchor: tavern, outdoors: false, activity: "tavern" };
    }
    return homeAt();
  }
  if (within(hour, 22, 6)) return homeAt();
  if (npc.cohort === "child") return within(hour, 9, 16) ? at(SQUARE, "idle") : homeAt();
  if (!home) return at(SQUARE, "idle"); // the homeless are about the square all day
  return within(hour, 9, 17) ? at(SQUARE, "idle") : homeAt();
}
