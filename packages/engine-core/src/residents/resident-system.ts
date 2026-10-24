/**
 * ResidentSystem (SG3b, R1): the people who live in the baked towns, in the world.
 *
 * Every town's occupancy (who lives where, who works where) is derived data, so residents are
 * not authored and not saved: a restart gives the same people in the same places for the same
 * time of day. Once a second each resident's schedule (a pure function in @mmo-engine/settlement,
 * injected here as `place`) says where they are: an outdoor resident has an entity standing at
 * their anchor, an indoor one has none (buildings are boxes), so at night nearly the whole town
 * costs nothing. A look is seeded from the npc's id, so they look the same on every boot and to
 * every player. A region budget (`maxEntities`) caps how many exist at once.
 *
 * With `steer` (a navigation crowd runs) a resident whose anchor changes walks there through the crowd:
 * they come out of the building they were in (their last anchor) and walk to the next; one headed
 * indoors walks to the door first and is gone on arrival. Without it they simply appear in place.
 *
 * Tiers (RS3): a town is only simulated near a player. Within `fullM` of its edge its residents walk
 * (a NavAgent each, up to `maxFull` region-wide); within `coarseM` they stand at their anchor and snap
 * when their block changes (no crowd slot); farther, the town has no entities at all and is placed from
 * the schedule when a player comes. A town moves between tiers with 25 m of hysteresis.
 *
 * Attackable (RS7): residents have health and anyone may hurt them (the weak points of a town are its
 * people). One who falls lies there for `corpseSeconds`, then is gone, and that npc stays dead until
 * `replaceMs` have passed; then "someone new has moved in" into the same household slot: the same npc
 * id, a new generation, so a new look. Deaths are kept in the places store (kind "resident"), so a
 * restart does not bring the dead back.
 *
 * Raids (RS6): when raiders are at a town, everyone outdoors runs for their home (sprinting if they
 * can walk) and is gone on arrival; guards and the watch hold their posts. Twenty to sixty seconds
 * (seeded) after the raid ends, schedules resume, and talk is in the raid's voice meanwhile.
 *
 * Later slices: homesteads.
 */

import { addComponent, defineQuery, entityExists, removeComponent } from "bitecs";
import { LocomotionMode } from "@mmo-engine/protocol";
import { HAIR_COLOURS, SKIN_TONES, lookToJson, randomLook, type CharacterLook, type Gender, type ModularCatalog } from "@mmo-engine/art/character";
import * as C from "../components.js";
import type { PlacesStore } from "../interact/places-store.js";
import type { SimSystem } from "../systems.js";
import type { SimWorld } from "../world.js";

/** The parts of a baked npc the system needs (settlement's Npc). */
export interface ResidentNpc {
  id: string;
  home: string | null;
  role: string;
  class: string;
  cohort: string;
}

/** Where a resident is now (settlement's Placement). */
export interface ResidentPlacement {
  anchor: string;
  outdoors: boolean;
  activity: string;
}

export interface ResidentTown {
  id: string;
  npcs: readonly ResidentNpc[];
  /** World position of an anchor: a structure id, or the square. Undefined: unknown (the resident is not placed). */
  positionOf(anchor: string): { x: number; z: number } | undefined;
  /** The town's centre and its radius (tiers go by the nearest player's distance to its edge); absent: always fully simulated. */
  centre?: { x: number; z: number };
  radius?: number;
}

export interface ResidentOptions {
  towns: readonly ResidentTown[];
  /** Where `npc` is at a time of day (0..1) in `town`. */
  place: (town: ResidentTown, npc: ResidentNpc, timeOfDay: number) => ResidentPlacement;
  /** Time of day (0..1) at a tick; absent: noon. */
  timeOfDay?: (tick: number) => number;
  /** The part catalog for looks (null: default parts, varied colours). */
  catalog: ModularCatalog | null;
  groundHeightAt?: (x: number, z: number) => number;
  /** Most resident entities at once, region-wide. Default 800. */
  maxEntities?: number;
  tickHz?: number;
  /** What a resident says (generated; settlement's barkFor). */
  bark?: (town: ResidentTown, npc: ResidentNpc, ctx: { timeOfDay: number; day: number; raid: boolean }) => string;
  /** The game day number at a tick (the line changes with it). */
  dayOf?: (tick: number) => number;
  /** Where deaths are kept across a restart (places.db, kind "resident"). */
  store?: PlacesStore;
  now?: () => number;
  /** How long a dead resident stays dead before someone new moves in, ms. Default three game days of an hour each. */
  replaceMs?: number;
  /** How long a body lies where it fell, seconds. Default 10. */
  corpseSeconds?: number;
  /** The settlements raiders are at now (a town within their reach is under raid). */
  raided?: () => ReadonlyArray<{ x: number; z: number; radius: number }>;
  /** Who stays at their post in a raid (default: guards, the watch, soldiers). */
  holds?: (npc: ResidentNpc) => boolean;
  /** A navigation crowd runs after this system: residents walk between anchors by NavAgent targets. */
  steer?: boolean;
  /** A player within this of a town's edge: its residents walk (full tier). Default 150 m. */
  fullM?: number;
  /** Within this: they stand at their anchor (coarse tier); beyond, nothing exists. Default 400 m. */
  coarseM?: number;
  /** Most walking residents (crowd agents) region-wide. Default 300. */
  maxFull?: number;
}

export type ResidentTier = "full" | "coarse" | "none";

/** What a resident is, for the interaction system (R5). */
export interface ResidentInfo {
  npc: string;
  town: string;
  role: string;
  class: string;
  cohort: string;
}

/** A small seeded generator (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

interface Live {
  eid: number;
  anchor: string;
  /** Walking to this spot (steered). */
  walkTo: { x: number; z: number } | null;
  /** Give up walking at this tick. */
  until: number;
  /** Heading indoors: gone on arrival. */
  leaving: boolean;
  /** The target waits for the crowd to take the new agent (it does on the next tick), then is given. */
  giveAt: number;
  /** Has a NavAgent (a crowd slot). */
  agent: boolean;
  /** The tick they fell (0: standing). */
  fellAt: number;
}

/** Longest a resident walks to an anchor before they are simply there, seconds. */
const WALK_LIMIT_S = 90;

export class ResidentSystem implements SimSystem {
  readonly name = "residents";
  private readonly maxEntities: number;
  private readonly tickHz: number;
  private readonly live = new Map<string, Live>();
  private readonly infoOf = new Map<number, ResidentInfo>();
  private readonly looks = new Map<string, string>();
  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
  /** Where each resident was last (their anchor, indoors or out): the door they come out of. */
  private readonly lastAnchor = new Map<string, string>();
  private ran = false;
  private readonly tiers = new Map<string, ResidentTier>();
  private readonly players = defineQuery([C.Transform, C.CharacterRef]);
  private agents = 0;
  /** Towns under raid, and (once it ends) when they carry on again. */
  private readonly raidClear = new Map<string, number>();
  private readonly index = new Map<string, { town: ResidentTown; npc: ResidentNpc }>();
  /** Per npc: how many have lived in their slot (a new one moves in after a death) and, while dead, when the next arrives (ms). */
  private readonly fate = new Map<string, { generation: number; backAt: number | null }>();

  constructor(private readonly opts: ResidentOptions) {
    this.maxEntities = opts.maxEntities ?? 800;
    this.tickHz = opts.tickHz ?? 30;
    for (const town of opts.towns) for (const npc of town.npcs) this.index.set(npc.id, { town, npc });
  }

  /** The resident an entity is (undefined: not one). */
  describe(eid: number): ResidentInfo | undefined {
    return this.infoOf.get(eid);
  }

  /** The entity a resident has now (undefined: indoors, or over the budget). */
  entityOf(npc: string): number | undefined {
    return this.live.get(npc)?.eid;
  }

  get count(): number {
    return this.live.size;
  }

  /** Whether `eid` is a resident, so DeathSystem leaves its body lying (it does not rise). */
  isResident(eid: number): boolean {
    return this.infoOf.has(eid);
  }

  /** How many have died in an npc's slot so far (their look changes with it). */
  generationOf(npc: string): number {
    return this.fateOf(npc).generation;
  }

  /** The npc's slot: how many have lived there, and when the next arrives while it stands empty. Read from the store once. */
  private fateOf(npc: string): { generation: number; backAt: number | null } {
    let f = this.fate.get(npc);
    if (!f) {
      f = { generation: 0, backAt: null };
      const rec = this.opts.store?.load("resident", npc);
      if (rec) {
        const n = Number(rec.state.split(":")[1] ?? 0);
        f.generation = Number.isFinite(n) ? n : 0;
        f.backAt = rec.state.startsWith("dead") ? rec.respawnAt : null;
      }
      this.fate.set(npc, f);
    }
    return f;
  }

  /** What the resident `eid` says now, and their display name; undefined when it is not a resident. */
  talk(eid: number, tick: number): { npc: string; name: string; text: string } | undefined {
    const info = this.infoOf.get(eid);
    const entry = info ? this.index.get(info.npc) : undefined;
    if (!info || !entry) return undefined;
    const timeOfDay = this.opts.timeOfDay?.(tick) ?? 0.5;
    const text = this.opts.bark?.(entry.town, entry.npc, { timeOfDay, day: this.opts.dayOf?.(tick) ?? 0, raid: this.raidClear.has(entry.town.id) }) ?? "...";
    return { npc: info.npc, name: info.role.charAt(0).toUpperCase() + info.role.slice(1), text };
  }

  /** Whether a town is under raid now, or has not yet recovered from one. */
  underRaid(town: string): boolean {
    return this.raidClear.has(town);
  }

  /** The tier a town is simulated at now. */
  tierOf(town: string): ResidentTier {
    return this.tiers.get(town) ?? "full";
  }

  /** Resident entities with a crowd slot. */
  get walking(): number {
    return this.agents;
  }

  step(sim: SimWorld): void {
    const tick = sim.currentTick;
    // Once a second; the first call places everyone.
    if (this.ran && tick % this.tickHz !== 0) return;
    this.ran = true;
    const t = this.opts.timeOfDay?.(tick) ?? 0.5;
    const towns = this.sortedByPlayer(sim);
    for (const town of towns) {
      const tier = this.tierFor(town, towns.dists.get(town.id) ?? 0);
      const prev = this.tiers.get(town.id);
      this.tiers.set(town.id, tier);
      if (tier === "none") {
        if (prev !== "none") for (const npc of town.npcs) if (this.live.has(npc.id)) this.remove(sim, npc.id, this.live.get(npc.id)!);
        continue; // nothing exists here; placed from the schedule when a player comes
      }
      if (tier === "coarse" && prev === "full") for (const npc of town.npcs) this.stopWalking(sim, this.live.get(npc.id));
      if (prev === "none") for (const npc of town.npcs) this.lastAnchor.delete(npc.id); // placed in place, not walking out of doors
      const steer = this.opts.steer === true && tier === "full";
      const raid = this.raidState(town, tick);
      for (const npc of town.npcs) {
        const fate = this.fateOf(npc.id);
        const have0 = this.live.get(npc.id);
        if (have0 && entityExists(sim.ecs, have0.eid) && C.Health.current[have0.eid]! <= 0) this.fall(sim, npc.id, have0, tick, fate);
        if (fate.backAt !== null) {
          if (this.now() < fate.backAt) continue; // lies dead, or the slot stands empty
          fate.generation++; // someone new has moved in
          fate.backAt = null;
          this.opts.store?.save({ kind: "resident", key: npc.id, state: `alive:${fate.generation}`, at: this.now(), respawnAt: null });
        }
        let p = this.opts.place(town, npc, t);
        // Raiders at the gates: anyone outdoors who is not on guard takes cover at home.
        if (raid && p.outdoors && !this.holds(npc) && npc.home) p = { anchor: npc.home, outdoors: false, activity: "hide" };
        const have = this.live.get(npc.id);
        const before = this.lastAnchor.get(npc.id);
        this.lastAnchor.set(npc.id, p.anchor);
        if (have && entityExists(sim.ecs, have.eid)) this.arrive(sim, npc.id, have, tick);
        const live = this.live.get(npc.id);
        if (!p.outdoors) {
          if (!live) continue;
          const door = town.positionOf(p.anchor);
          if (steer && live.agent && door && !live.leaving) {
            // Walk to the door of the building; gone when they get there.
            live.leaving = true;
            this.walk(sim, live, npc.id, p.anchor, door, tick, raid);
          } else if (!(steer && live.agent) || !door) this.remove(sim, npc.id, live);
          continue;
        }
        const pos = town.positionOf(p.anchor);
        if (!pos) {
          if (live) this.remove(sim, npc.id, live);
          continue;
        }
        if (live && entityExists(sim.ecs, live.eid)) {
          if (live.anchor !== p.anchor || live.leaving) {
            live.leaving = false;
            if (steer && live.agent) this.walk(sim, live, npc.id, p.anchor, pos, tick);
            else this.stand(sim, live.eid, npc.id, p.anchor, pos);
            live.anchor = p.anchor;
          }
          continue;
        }
        if (live) this.remove(sim, npc.id, live);
        if (this.live.size >= this.maxEntities) continue;
        const eid = this.spawn(sim, town, npc);
        const wantAgent = steer && this.agents < (this.opts.maxFull ?? 300);
        if (wantAgent) this.addAgent(sim, eid);
        const entry: Live = { eid, anchor: p.anchor, walkTo: null, until: 0, leaving: false, giveAt: 0, agent: wantAgent, fellAt: 0 };
        this.live.set(npc.id, entry);
        const from = wantAgent && before && before !== p.anchor ? town.positionOf(before) : undefined;
        if (from) {
          // They come out of the building they were in and walk to where they are headed.
          this.stand(sim, eid, npc.id, before!, from);
          this.walk(sim, entry, npc.id, p.anchor, pos, tick);
        } else this.stand(sim, eid, npc.id, p.anchor, pos);
      }
    }
  }

  /** Towns nearest the nearest player first, with each town's distance (metres from its edge). */
  private sortedByPlayer(sim: SimWorld): ResidentTown[] & { dists: Map<string, number> } {
    const ps = this.players(sim.ecs);
    const dists = new Map<string, number>();
    for (const t of this.opts.towns) {
      if (!t.centre) {
        dists.set(t.id, 0);
        continue;
      }
      let d = Infinity;
      for (const p of ps) d = Math.min(d, Math.hypot(C.Transform.px[p]! - t.centre.x, C.Transform.pz[p]! - t.centre.z) - (t.radius ?? 0));
      dists.set(t.id, d);
    }
    const sorted = [...this.opts.towns].sort((a, b) => dists.get(a.id)! - dists.get(b.id)!) as ResidentTown[] & { dists: Map<string, number> };
    sorted.dists = dists;
    return sorted;
  }

  /** The tier for a town `d` metres from the nearest player, with 25 m of hysteresis against the tier it has. */
  private tierFor(town: ResidentTown, d: number): ResidentTier {
    const full = this.opts.fullM ?? 150;
    const coarse = this.opts.coarseM ?? 400;
    const was = this.tiers.get(town.id);
    const edge = (m: number, tier: ResidentTier): number => m + (was === tier ? 25 : 0);
    if (d <= edge(full, "full")) return "full";
    if (d <= edge(coarse, "coarse") || (was === "full" && d <= coarse + 25)) return "coarse";
    return "none";
  }

  private addAgent(sim: SimWorld, eid: number): void {
    addComponent(sim.ecs, C.NavAgent, eid);
    C.NavAgent.speed[eid] = sim.movement.bots.wanderPace * sim.movement.walkSpeed;
    C.NavAgent.tx[eid] = NaN;
    C.NavAgent.seq[eid] = 0;
    this.agents++;
  }

  /** A town fell to the coarse tier: its walkers stand where they are and give up their crowd slots. */
  private stopWalking(sim: SimWorld, live: Live | undefined): void {
    if (!live || !live.agent || !entityExists(sim.ecs, live.eid)) return;
    removeComponent(sim.ecs, C.NavAgent, live.eid);
    live.agent = false;
    live.walkTo = null;
    live.giveAt = 0;
    this.agents--;
  }

  /** Send a resident walking to their spot at an anchor (the crowd steers; a resident not on the navmesh is put there). */
  private walk(sim: SimWorld, live: Live, npc: string, anchor: string, pos: { x: number; z: number }, tick: number, run = false): void {
    const spot = this.spotAt(npc, anchor, pos);
    if (live.agent) C.NavAgent.speed[live.eid] = sim.movement.bots.wanderPace * sim.movement.walkSpeed * (run ? 2.2 : 1);
    live.walkTo = spot;
    live.until = tick + WALK_LIMIT_S * this.tickHz;
    // A fresh agent is not on the crowd yet: give the target on the next pass.
    if (C.NavAgent.state[live.eid] === C.NavAgentState.Invalid) live.giveAt = tick + 1;
    else this.give(live, spot);
  }

  private give(live: Live, spot: { x: number; z: number }): void {
    live.giveAt = 0;
    C.NavAgent.tx[live.eid] = spot.x;
    C.NavAgent.ty[live.eid] = this.opts.groundHeightAt?.(spot.x, spot.z) ?? C.Transform.py[live.eid]!;
    C.NavAgent.tz[live.eid] = spot.z;
    C.NavAgent.seq[live.eid] = (C.NavAgent.seq[live.eid]! + 1) & 0xffff;
  }

  /** Has a walking resident got there (or given up)? Then they stand, or go indoors if that was the errand. */
  private arrive(sim: SimWorld, npc: string, live: Live, tick: number): void {
    if (!live.walkTo) {
      if (live.leaving) this.remove(sim, npc, live);
      return;
    }
    if (live.giveAt > 0) {
      if (C.NavAgent.state[live.eid] === C.NavAgentState.Invalid) {
        // Not on the navmesh (or no crowd): they are simply there.
        C.Transform.px[live.eid] = live.walkTo.x;
        C.Transform.pz[live.eid] = live.walkTo.z;
        C.Transform.py[live.eid] = this.opts.groundHeightAt?.(live.walkTo.x, live.walkTo.z) ?? C.Transform.py[live.eid]!;
        live.walkTo = null;
        live.giveAt = 0;
        if (live.leaving) this.remove(sim, npc, live);
        return;
      }
      this.give(live, live.walkTo);
      return;
    }
    const d = Math.hypot(live.walkTo.x - C.Transform.px[live.eid]!, live.walkTo.z - C.Transform.pz[live.eid]!);
    if (d > 1.5 && tick < live.until && C.NavAgent.state[live.eid] !== C.NavAgentState.NoPath) return;
    live.walkTo = null;
    C.NavAgent.tx[live.eid] = NaN; // stand
    C.NavAgent.tz[live.eid] = NaN;
    C.NavAgent.seq[live.eid] = (C.NavAgent.seq[live.eid]! + 1) & 0xffff;
    if (live.leaving) this.remove(sim, npc, live);
  }

  /** A resident fell: record the death, leave the body a while, then it goes. */
  private fall(sim: SimWorld, npc: string, live: Live, tick: number, fate: { generation: number; backAt: number | null }): void {
    if (live.fellAt === 0) {
      live.fellAt = tick;
      fate.backAt = this.now() + (this.opts.replaceMs ?? 3 * 3_600_000);
      this.opts.store?.save({ kind: "resident", key: npc, state: `dead:${fate.generation}`, at: this.now(), respawnAt: fate.backAt });
    }
    if (tick - live.fellAt >= (this.opts.corpseSeconds ?? 10) * this.tickHz) this.remove(sim, npc, live);
  }

  private holds(npc: ResidentNpc): boolean {
    return this.opts.holds ? this.opts.holds(npc) : npc.class === "guard" || /guard|watch|soldier/i.test(npc.role);
  }

  /**
   * Whether `town` is under raid at this tick: raiders are at it now, or the raid ended too recently
   * (20 to 60 s, seeded by the town) for people to come out.
   */
  private raidState(town: ResidentTown, tick: number): boolean {
    const raided = this.opts.raided?.() ?? [];
    const c = town.centre;
    const now = c !== undefined && raided.some((s) => Math.hypot(s.x - c.x, s.z - c.z) <= (town.radius ?? 0) + s.radius + 30);
    if (now) {
      this.raidClear.set(town.id, Infinity);
      return true;
    }
    const until = this.raidClear.get(town.id);
    if (until === undefined) return false;
    if (until === Infinity) {
      this.raidClear.set(town.id, tick + (20 + (hashOf(town.id) % 41)) * this.tickHz);
      return true;
    }
    if (tick >= until) {
      this.raidClear.delete(town.id);
      return false;
    }
    return true;
  }

  private remove(sim: SimWorld, npc: string, have: Live): void {
    if (have.agent) this.agents--;
    if (entityExists(sim.ecs, have.eid)) sim.despawn(have.eid);
    this.infoOf.delete(have.eid);
    this.live.delete(npc);
  }

  /** Put a resident at their anchor, on a spot of their own around it (so a crowd at the square does not stack). */
  private stand(sim: SimWorld, eid: number, npc: string, anchor: string, pos: { x: number; z: number }): void {
    const { x, z } = this.spotAt(npc, anchor, pos);
    C.Transform.px[eid] = x;
    C.Transform.pz[eid] = z;
    C.Transform.py[eid] = this.opts.groundHeightAt?.(x, z) ?? 0;
    // Face the anchor's heart (a yaw about Y).
    const yaw = Math.atan2(pos.x - x, pos.z - z);
    C.Transform.qy[eid] = Math.sin(yaw / 2);
    C.Transform.qw[eid] = Math.cos(yaw / 2);
    void sim;
  }

  /** A spot of their own around an anchor, the same on every boot. */
  private spotAt(npc: string, anchor: string, pos: { x: number; z: number }): { x: number; z: number } {
    const h = hashOf(`${npc}|${anchor}`);
    const r = anchor.startsWith("@") ? 3 + (h % 900) / 100 : 2.5 + (h % 250) / 100;
    const a = ((h >>> 9) % 6283) / 1000;
    return { x: pos.x + Math.cos(a) * r, z: pos.z + Math.sin(a) * r };
  }

  private spawn(sim: SimWorld, town: ResidentTown, npc: ResidentNpc): number {
    const eid = sim.spawn();
    for (const c of [C.Transform, C.Velocity, C.PlayerIntent, C.Health, C.Locomotion, C.Action]) addComponent(sim.ecs, c, eid);
    C.Transform.qx[eid] = 0;
    C.Transform.qz[eid] = 0;
    C.Transform.sx[eid] = C.Transform.sy[eid] = C.Transform.sz[eid] = npc.cohort === "child" ? 0.7 : 1;
    C.Health.current[eid] = 100;
    C.Health.max[eid] = 100;
    C.Locomotion.mode[eid] = LocomotionMode.Ground;
    C.Locomotion.abilities[eid] = 1;
    C.Locomotion.breath[eid] = 1;
    C.Action.move[eid] = 0;
    sim.setLook(eid, this.lookOf(npc.id));
    this.infoOf.set(eid, { npc: npc.id, town: town.id, role: npc.role, class: npc.class, cohort: npc.cohort });
    return eid;
  }

  /** The same look for the same npc on every boot (computed once, then cached). */
  private lookOf(npc: string): string {
    // A new arrival in a dead resident's slot looks different: the generation joins the seed.
    const gen = this.fateOf(npc).generation;
    const key = gen > 0 ? `${npc}#${gen}` : npc;
    let look = this.looks.get(key);
    if (look === undefined) {
      const h = hashOf(key);
      const rng = seeded(h);
      const gender: Gender = h & 1 ? "female" : "male";
      if (this.opts.catalog) look = lookToJson(randomLook(this.opts.catalog, gender, rng));
      else {
        const l: CharacterLook = { gender, parts: {}, colours: { skin: SKIN_TONES[Math.floor(rng() * SKIN_TONES.length)], hair: HAIR_COLOURS[Math.floor(rng() * HAIR_COLOURS.length)] } };
        look = lookToJson(l);
      }
      this.looks.set(key, look);
    }
    return look;
  }
}
