/**
 * CollapseSystem (DE4): buildings that fall when their parts are broken.
 *
 * Every part of a building is a static body, so nothing falls by itself, and that is what keeps a town cheap:
 * thousands of parts cost the physics world nothing. This system leaves them static and only, when a part breaks,
 * asks the building's support graph (`@mmo-engine/placement`, DE3) what lost its support, then turns exactly those
 * parts dynamic for a while so the physics world drops them, and freezes them where they land.
 *
 *   - Registered once per building with its parts' entities and boxes (`registerBuilding`); the graph is built then.
 *   - `partBroken(eid)` (the BreakSystem's `onBreak`) adds the part to the building's gone set and queues what
 *     falls, wave by wave: a wave is `waveDelayS` after the one before, so a collapse spreads instead of landing in a
 *     single tick.
 *   - Cost is bounded: at most `perTick` parts are released per tick and at most `maxActive` are dynamic at once;
 *     the rest wait in the queue. A settled part (slow for `settleS`, or older than `maxAgeS`) goes static again.
 *   - Jolt reads a body's motion type when the body is added, so a retype is two ticks: the body config comes off
 *     (PhysicsSystem drops the body), then goes back on with the new motion (it adds a new one). The entity, its wire
 *     id and its transform stay, so the client just sees it move.
 *   - The part's separate collider entities (`-pN-col`) are removed when it falls: they would hang in the air.
 *
 * Not persisted yet: a restart rebuilds the buildings whole (DE4b).
 */

import { addComponent, hasComponent, removeComponent } from "bitecs";
import { buildSupportGraph, collapseFrom, type SupportGraph, type SupportOptions, type SupportPart } from "@mmo-engine/placement";
import { BodyConfig, MotionType, Velocity } from "../components.js";
import type { SimWorld } from "../world.js";
import type { SimSystem } from "../systems.js";

export interface CollapsePartSpec {
  /** The part's entity. */
  eid: number;
  /** Entities that are this part's collision only (removed when it falls). */
  colliders: readonly number[];
  /** Its box, for the support graph. */
  part: SupportPart;
}

export interface CollapseOptions {
  /** Most parts dynamic at once (default 64). */
  maxActive?: number;
  /** Most parts released to physics per tick (default 8). */
  perTick?: number;
  /** Seconds between waves of a collapse (default 0.25). */
  waveDelayS?: number;
  /** A part slower than 5 cm/s for this long is at rest (default 1.5). */
  settleS?: number;
  /** A part still moving after this long is frozen where it is (default 12). */
  maxAgeS?: number;
  /** Mass in kg per cubic metre of a part's box (default 250). */
  density?: number;
  /** A part fell: its building key and entity (for effects, tallies). */
  onFall?: (sim: SimWorld, building: string, eid: number) => void;
}

interface Building {
  key: string;
  graph: SupportGraph;
  parts: Array<{ wid: bigint; colliders: bigint[] }>;
  /** Broken or already scheduled to fall: what the graph treats as gone. */
  gone: Set<number>;
}

interface Queued {
  building: Building;
  index: number;
  dueAt: number;
}

interface Retype {
  wid: bigint;
  motion: number;
  cfg: BodyCfg;
  /** The tick time it may be put back on. */
  at: number;
  /** For a part going dynamic: it starts being tracked as falling. */
  falling: boolean;
}

interface BodyCfg {
  shapeKind: number;
  halfX: number;
  halfY: number;
  halfZ: number;
  radius: number;
  friction: number;
  restitution: number;
}

interface Falling {
  wid: bigint;
  cfg: BodyCfg;
  since: number;
  slowSince: number | null;
}

const SLOW_MS = 0.05;

export class CollapseSystem implements SimSystem {
  readonly name = "collapse";
  private readonly buildings = new Map<string, Building>();
  private readonly of = new Map<bigint, { building: Building; index: number }>();
  private queue: Queued[] = [];
  private retypes: Retype[] = [];
  private falling: Falling[] = [];
  private now = 0;
  /** Parts that have been let fall so far. */
  fallen = 0;
  private readonly maxActive: number;
  private readonly perTick: number;
  private readonly waveDelayS: number;
  private readonly settleS: number;
  private readonly maxAgeS: number;
  private readonly density: number;

  constructor(private readonly opts: CollapseOptions = {}) {
    this.maxActive = opts.maxActive ?? 64;
    this.perTick = opts.perTick ?? 8;
    this.waveDelayS = opts.waveDelayS ?? 0.25;
    this.settleS = opts.settleS ?? 1.5;
    this.maxAgeS = opts.maxAgeS ?? 12;
    this.density = opts.density ?? 250;
  }

  /** Parts waiting to be released, and parts dynamic now. */
  get stats(): { queued: number; active: number; fallen: number; buildings: number } {
    return { queued: this.queue.length, active: this.falling.length + this.retypes.filter((r) => r.falling).length, fallen: this.fallen, buildings: this.buildings.size };
  }

  /** Register a building: its parts' entities and boxes. Builds its support graph once. */
  registerBuilding(sim: SimWorld, key: string, specs: readonly CollapsePartSpec[], o: SupportOptions = {}): SupportGraph {
    const graph = buildSupportGraph(specs.map((s) => s.part), o);
    const b: Building = { key, graph, parts: specs.map((s) => ({ wid: sim.wireId(s.eid), colliders: s.colliders.map((c) => sim.wireId(c)) })), gone: new Set() };
    this.buildings.set(key, b);
    specs.forEach((s, index) => this.of.set(sim.wireId(s.eid), { building: b, index }));
    return graph;
  }

  /** A part broke (or was taken out): queue everything that lost its support. Returns how many parts will fall. */
  partBroken(sim: SimWorld, eid: number): number {
    const at = this.of.get(sim.wireId(eid));
    if (!at) return 0;
    const { building, index } = at;
    building.gone.add(index);
    const fell = collapseFrom(building.graph, building.gone);
    for (const f of fell) {
      building.gone.add(f.index);
      this.queue.push({ building, index: f.index, dueAt: this.now + f.wave * this.waveDelayS });
    }
    return fell.length;
  }

  step(sim: SimWorld, dtSeconds: number): void {
    this.now += dtSeconds;
    this.settle(sim);
    this.release(sim);
    this.rearm(sim);
  }

  /** Put a part's body back on with its new motion, the tick after it came off. */
  private rearm(sim: SimWorld): void {
    if (this.retypes.length === 0) return;
    const later: Retype[] = [];
    for (const r of this.retypes) {
      if (r.at > this.now) {
        later.push(r);
        continue;
      }
      const eid = sim.resolveWireId(r.wid);
      if (eid < 0) continue;
      const B = BodyConfig;
      addComponent(sim.ecs, B, eid);
      B.shapeKind[eid] = r.cfg.shapeKind;
      B.halfX[eid] = r.cfg.halfX;
      B.halfY[eid] = r.cfg.halfY;
      B.halfZ[eid] = r.cfg.halfZ;
      B.radius[eid] = r.cfg.radius;
      B.friction[eid] = r.cfg.friction;
      B.restitution[eid] = r.cfg.restitution;
      if (r.motion === MotionType.Dynamic) {
        const volume = 8 * r.cfg.halfX * r.cfg.halfY * r.cfg.halfZ;
        B.mass[eid] = Math.min(2000, Math.max(5, volume * this.density));
        B.motionType[eid] = MotionType.Dynamic;
        B.layer[eid] = 1;
        this.falling.push({ wid: r.wid, cfg: r.cfg, since: this.now, slowSince: null });
      } else {
        B.mass[eid] = 0;
        B.motionType[eid] = MotionType.Static;
        B.layer[eid] = 0;
        Velocity.lx[eid] = Velocity.ly[eid] = Velocity.lz[eid] = 0;
      }
    }
    this.retypes = later;
  }

  /** Take parts that are due off to physics, within the per-tick and active caps. */
  private release(sim: SimWorld): void {
    if (this.queue.length === 0) return;
    let released = 0;
    const room = (): number => this.maxActive - this.falling.length - this.retypes.filter((r) => r.falling).length;
    const waiting: Queued[] = [];
    this.queue.sort((a, b) => a.dueAt - b.dueAt);
    for (const q of this.queue) {
      if (q.dueAt > this.now || released >= this.perTick || room() <= 0) {
        waiting.push(q);
        continue;
      }
      released++;
      const part = q.building.parts[q.index]!;
      const eid = sim.resolveWireId(part.wid);
      if (eid < 0) continue; // broken and gone meanwhile
      if (!hasComponent(sim.ecs, BodyConfig, eid)) continue; // a ruin or a prop with no body: nothing to drop
      for (const c of part.colliders) {
        const ce = sim.resolveWireId(c);
        if (ce >= 0) sim.despawn(ce);
      }
      this.retype(eid, sim.wireId(eid), MotionType.Dynamic, true, sim);
      this.fallen++;
      this.opts.onFall?.(sim, q.building.key, eid);
    }
    this.queue = waiting;
  }

  /** Freeze parts that have come to rest, or have been falling too long. */
  private settle(sim: SimWorld): void {
    if (this.falling.length === 0) return;
    const keep: Falling[] = [];
    for (const f of this.falling) {
      const eid = sim.resolveWireId(f.wid);
      if (eid < 0) continue;
      const speed = Math.hypot(Velocity.lx[eid]!, Velocity.ly[eid]!, Velocity.lz[eid]!);
      if (speed < SLOW_MS) f.slowSince ??= this.now;
      else f.slowSince = null;
      const rested = f.slowSince !== null && this.now - f.slowSince >= this.settleS;
      if (rested || this.now - f.since >= this.maxAgeS) {
        this.retype(eid, f.wid, MotionType.Static, false, sim, f.cfg);
      } else keep.push(f);
    }
    this.falling = keep;
  }

  /** Step one of a retype: the body comes off now; `rearm` puts it back on next tick with `motion`. */
  private retype(eid: number, wid: bigint, motion: number, falling: boolean, sim: SimWorld, cfg?: BodyCfg): void {
    const B = BodyConfig;
    const keep: BodyCfg = cfg ?? {
      shapeKind: B.shapeKind[eid]!,
      halfX: B.halfX[eid]!,
      halfY: B.halfY[eid]!,
      halfZ: B.halfZ[eid]!,
      radius: B.radius[eid]!,
      friction: B.friction[eid]!,
      restitution: motion === MotionType.Dynamic ? 0.1 : B.restitution[eid]!,
    };
    if (!hasComponent(sim.ecs, Velocity, eid)) {
      addComponent(sim.ecs, Velocity, eid);
      Velocity.lx[eid] = Velocity.ly[eid] = Velocity.lz[eid] = 0;
      Velocity.ax[eid] = Velocity.ay[eid] = Velocity.az[eid] = 0;
    }
    removeComponent(sim.ecs, BodyConfig, eid);
    // The physics step that follows drops the body; the next tick's step puts the new one on.
    this.retypes.push({ wid, motion, cfg: keep, at: this.now + 1e-9, falling });
  }
}
