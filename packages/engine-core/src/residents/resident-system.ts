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
 * Later slices: tiers by distance, homesteads, raids, attackability.
 */

import { addComponent, entityExists } from "bitecs";
import { LocomotionMode } from "@mmo-engine/protocol";
import { HAIR_COLOURS, SKIN_TONES, lookToJson, randomLook, type CharacterLook, type Gender, type ModularCatalog } from "@mmo-engine/art/character";
import * as C from "../components.js";
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
  /** A navigation crowd runs after this system: residents walk between anchors by NavAgent targets. */
  steer?: boolean;
}

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
  /** Where each resident was last (their anchor, indoors or out): the door they come out of. */
  private readonly lastAnchor = new Map<string, string>();
  private ran = false;

  constructor(private readonly opts: ResidentOptions) {
    this.maxEntities = opts.maxEntities ?? 800;
    this.tickHz = opts.tickHz ?? 30;
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

  step(sim: SimWorld): void {
    const tick = sim.currentTick;
    // Once a second; the first call places everyone.
    if (this.ran && tick % this.tickHz !== 0) return;
    this.ran = true;
    const t = this.opts.timeOfDay?.(tick) ?? 0.5;
    const steer = this.opts.steer === true;
    for (const town of this.opts.towns) {
      for (const npc of town.npcs) {
        const p = this.opts.place(town, npc, t);
        const have = this.live.get(npc.id);
        const before = this.lastAnchor.get(npc.id);
        this.lastAnchor.set(npc.id, p.anchor);
        if (have && entityExists(sim.ecs, have.eid)) this.arrive(sim, npc.id, have, tick);
        const live = this.live.get(npc.id);
        if (!p.outdoors) {
          if (!live) continue;
          const door = town.positionOf(p.anchor);
          if (steer && door && !live.leaving) {
            // Walk to the door of the building; gone when they get there.
            live.leaving = true;
            this.walk(sim, live, npc.id, p.anchor, door, tick);
          } else if (!steer || !door) this.remove(sim, npc.id, live);
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
            if (steer) this.walk(sim, live, npc.id, p.anchor, pos, tick);
            else this.stand(sim, live.eid, npc.id, p.anchor, pos);
            live.anchor = p.anchor;
          }
          continue;
        }
        if (live) this.remove(sim, npc.id, live);
        if (this.live.size >= this.maxEntities) continue;
        const eid = this.spawn(sim, town, npc);
        const entry: Live = { eid, anchor: p.anchor, walkTo: null, until: 0, leaving: false, giveAt: 0 };
        this.live.set(npc.id, entry);
        const from = steer && before && before !== p.anchor ? town.positionOf(before) : undefined;
        if (from) {
          // They come out of the building they were in and walk to where they are headed.
          this.stand(sim, eid, npc.id, before!, from);
          this.walk(sim, entry, npc.id, p.anchor, pos, tick);
        } else this.stand(sim, eid, npc.id, p.anchor, pos);
      }
    }
  }

  /** Send a resident walking to their spot at an anchor (the crowd steers; a resident not on the navmesh is put there). */
  private walk(sim: SimWorld, live: Live, npc: string, anchor: string, pos: { x: number; z: number }, tick: number): void {
    const spot = this.spotAt(npc, anchor, pos);
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

  private remove(sim: SimWorld, npc: string, have: Live): void {
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
    if (this.opts.steer) {
      addComponent(sim.ecs, C.NavAgent, eid);
      C.NavAgent.speed[eid] = sim.movement.bots.wanderPace * sim.movement.walkSpeed;
      C.NavAgent.tx[eid] = NaN;
      C.NavAgent.seq[eid] = 0;
    }
    sim.setLook(eid, this.lookOf(npc.id));
    this.infoOf.set(eid, { npc: npc.id, town: town.id, role: npc.role, class: npc.class, cohort: npc.cohort });
    return eid;
  }

  /** The same look for the same npc on every boot (computed once, then cached). */
  private lookOf(npc: string): string {
    let look = this.looks.get(npc);
    if (look === undefined) {
      const h = hashOf(npc);
      const rng = seeded(h);
      const gender: Gender = h & 1 ? "female" : "male";
      if (this.opts.catalog) look = lookToJson(randomLook(this.opts.catalog, gender, rng));
      else {
        const l: CharacterLook = { gender, parts: {}, colours: { skin: SKIN_TONES[Math.floor(rng() * SKIN_TONES.length)], hair: HAIR_COLOURS[Math.floor(rng() * HAIR_COLOURS.length)] } };
        look = lookToJson(l);
      }
      this.looks.set(npc, look);
    }
    return look;
  }
}
