/**
 * Populating a dungeon: which species holds each room (WFC over the room
 * graph; the layout's spawn points already say where they stand).
 *
 *  - A room can hold a species that haunts this theme, at this depth, at
 *    this rank, able to fill the room's spawn tier; the boss room needs one
 *    that can lead it.
 *  - Room archetypes draw species (a ritual chamber, demons; a crypt, the
 *    undead): their weight there is multiplied.
 *  - Kinds that can't coexist never share a doorway: the living shun
 *    demons and the undead.
 *
 * Deterministic: the same dungeon, roster, rank, dressing and seed give the
 * same population.
 */

import { kindsCoexist, type Roster } from "@mmo-engine/species";
import { solve, type WfcOption, type WfcProblem } from "@mmo-engine/wfc";
import type { Dungeon, Spawn } from "./generate.js";
import { deriveSeed } from "./rng.js";

export interface PopulatedSpawn extends Spawn {
  species: string;
}

export interface Population {
  /** Species per room ("" where a room has no spawns, or nothing can live there). */
  rooms: string[];
  spawns: PopulatedSpawn[];
  /** Rules that couldn't all hold and were loosened (a roster too thin for this dungeon). */
  relaxed: string[];
}

export function populateDungeon(d: Dungeon, roster: Roster, rank: number, archetypes: readonly string[] | null, seed = d.seed): Population {
  const theme = d.params.theme;
  const ids = Object.keys(roster);
  const options: WfcOption[] = [{ id: "", weight: 1 }, ...ids.map((id) => ({ id, weight: 1 }))];
  const N = d.rooms.length, K = options.length;
  const tierOf = new Map<number, number>();
  for (const s of d.spawns) tierOf.set(s.room, Math.max(tierOf.get(s.room) ?? 0, s.tier));

  const lives = (id: string): boolean => {
    const sp = roster[id];
    return !!sp.habitat.dungeon && (sp.habitat.dungeon.themes[theme] ?? 0) > 0 && rank >= sp.minRank;
  };
  const weightIn = (id: string, room: number): number => {
    const sp = roster[id];
    const base = sp.habitat.dungeon?.themes[theme] ?? 0;
    const pull = archetypes ? (sp.drawnTo[archetypes[room]] ?? 1) : 1;
    // The boss room favours the bosses of this dungeon's rank.
    return base * pull * (room === d.boss && sp.boss ? sp.minRank : 1);
  };
  // How well a species fits a room, strictest first: 0 depth, tier and the boss
  // role (bosses in the boss room, others everywhere else); 1 the tier only;
  // 2 any dweller of the theme. A room takes the
  // strictest level anything fits (a thin roster steps down, room by room).
  const fitsAt = (id: string, room: number, level: number): boolean => {
    if (!lives(id)) return false;
    if (level >= 2) return true;
    const sp = roster[id], r = d.rooms[room], tier = tierOf.get(room) ?? 1;
    if (tier < sp.tier[0] || tier > sp.tier[1]) return false;
    if (level >= 1) return true;
    const [lo, hi] = sp.habitat.dungeon!.depth;
    if (r.difficulty < lo - 0.05 || r.difficulty > hi + 0.05) return false;
    // Bosses lead the boss room, and only it.
    return room === d.boss ? sp.boss : !sp.boss;
  };
  const fits = (id: string, room: number, strict: boolean): boolean => {
    if (!strict) return fitsAt(id, room, 2);
    for (let level = 0; level <= 2; level++) {
      if (ids.some((other) => fitsAt(other, room, level))) return fitsAt(id, room, level);
    }
    return false;
  };

  const build = (strict: boolean, rules: boolean): WfcProblem => {
    const weights = new Float64Array(N * K);
    for (let r = 0; r < N; r++) {
      if (!tierOf.has(r)) {
        weights[r * K] = 1;
        continue;
      }
      let any = false;
      ids.forEach((id, i) => {
        if (fits(id, r, strict)) {
          weights[r * K + 1 + i] = weightIn(id, r);
          any = any || weights[r * K + 1 + i] > 0;
        }
      });
      if (!any) weights[r * K] = 1;
    }
    return {
      options,
      slots: N,
      weights,
      edges: rules ? d.corridors.map((e) => ({ a: e.a, b: e.b, rule: "coexist" })) : [],
      rules: {
        coexist: (x, y) => !x.id || !y.id || kindsCoexist(roster[x.id].kind, roster[y.id].kind),
      },
    };
  };

  const relaxed: string[] = [];
  const s = deriveSeed(seed, 0x504f50);
  let assignment: Int32Array;
  try {
    assignment = solve(build(true, true), { seed: s }).assignment;
  } catch {
    relaxed.push("fit");
    try {
      assignment = solve(build(false, true), { seed: s }).assignment;
    } catch {
      relaxed.push("coexist");
      assignment = solve(build(false, false), { seed: s }).assignment;
    }
  }
  const rooms = Array.from(assignment, (k) => options[k].id);
  const spawns = d.spawns.flatMap((sp) => (rooms[sp.room] ? [{ ...sp, species: rooms[sp.room] }] : []));
  return { rooms, spawns, relaxed };
}
