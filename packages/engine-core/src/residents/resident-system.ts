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
 * Later slices: walking between anchors, tiers by distance, homesteads, raids, attackability.
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
}

export class ResidentSystem implements SimSystem {
  readonly name = "residents";
  private readonly maxEntities: number;
  private readonly tickHz: number;
  private readonly live = new Map<string, Live>();
  private readonly infoOf = new Map<number, ResidentInfo>();
  private readonly looks = new Map<string, string>();
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
    for (const town of this.opts.towns) {
      for (const npc of town.npcs) {
        const p = this.opts.place(town, npc, t);
        const have = this.live.get(npc.id);
        if (!p.outdoors) {
          if (have) this.remove(sim, npc.id, have);
          continue;
        }
        const pos = town.positionOf(p.anchor);
        if (!pos) {
          if (have) this.remove(sim, npc.id, have);
          continue;
        }
        if (have && entityExists(sim.ecs, have.eid)) {
          if (have.anchor !== p.anchor) {
            this.stand(sim, have.eid, npc.id, p.anchor, pos);
            have.anchor = p.anchor;
          }
          continue;
        }
        if (have) this.remove(sim, npc.id, have);
        if (this.live.size >= this.maxEntities) continue;
        const eid = this.spawn(sim, town, npc);
        this.stand(sim, eid, npc.id, p.anchor, pos);
        this.live.set(npc.id, { eid, anchor: p.anchor });
      }
    }
  }

  private remove(sim: SimWorld, npc: string, have: Live): void {
    if (entityExists(sim.ecs, have.eid)) sim.despawn(have.eid);
    this.infoOf.delete(have.eid);
    this.live.delete(npc);
  }

  /** Put a resident at their anchor, on a spot of their own around it (so a crowd at the square does not stack). */
  private stand(sim: SimWorld, eid: number, npc: string, anchor: string, pos: { x: number; z: number }): void {
    const h = hashOf(`${npc}|${anchor}`);
    const r = anchor.startsWith("@") ? 3 + (h % 900) / 100 : 2.5 + (h % 250) / 100;
    const a = ((h >>> 9) % 6283) / 1000;
    const x = pos.x + Math.cos(a) * r;
    const z = pos.z + Math.sin(a) * r;
    C.Transform.px[eid] = x;
    C.Transform.pz[eid] = z;
    C.Transform.py[eid] = this.opts.groundHeightAt?.(x, z) ?? 0;
    // Face the anchor's heart (a yaw about Y).
    const yaw = Math.atan2(pos.x - x, pos.z - z);
    C.Transform.qy[eid] = Math.sin(yaw / 2);
    C.Transform.qw[eid] = Math.cos(yaw / 2);
    void sim;
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
