/**
 * CollapseSystem (DE4): buildings that fall when their parts are broken.
 *
 * Every part of a building stays static until one breaks, and that is what keeps a town cheap: thousands of parts
 * cost the physics world nothing. When a part breaks, this system asks the building's support graph
 * (`@mmo-engine/placement`, DE3) what lost its support and lets exactly those parts fall, wave by wave, within caps.
 *
 * A synthesized building's part is two things: a *visual* entity (the model, drawn at its pivot, no body) and
 * separate *collider* entities (static boxes round the model's real middle). To fall, a part:
 *   1. loses its collider entities,
 *   2. gets a *carrier*: a dynamic box body at the model's middle (hidden on the client like any collider), which
 *      the physics world drops,
 *   3. and its visual follows the carrier every tick, offset by the pivot (the model's pivot is not its middle).
 * At rest the dynamic carrier is replaced by a static one where it lies (the rubble blocks the way) and the visual
 * keeps its final pose; a part that is still moving after `maxAgeS` is frozen the same way.
 *
 * Cost is bounded: at most `perTick` parts are released per tick and at most `maxActive` carriers are dynamic at
 * once; the rest wait in the queue. Not persisted yet: a restart rebuilds the buildings whole (DE4b).
 */

import { addComponent } from "bitecs";
import { buildSupportGraph, collapseFrom, type SupportGraph, type SupportOptions, type SupportPart } from "@mmo-engine/placement";
import { fnv1a32 } from "@mmo-engine/scatter";
import { AssetRef, BodyConfig, MotionType, ShapeKind, Transform, Velocity } from "../components.js";
import type { SimWorld } from "../world.js";
import type { SimSystem } from "../systems.js";

/** The asset hash the client hides (collision-only entities). */
const COLLIDER_HASH = fnv1a32("collider") >>> 0;

export interface CollapsePartSpec {
  /** The part's visual entity (the model, at its pivot). */
  eid: number;
  /** Entities that are this part's collision only (removed when it falls). */
  colliders: readonly number[];
  /** Its box, for the support graph and its carrier: the middle of the model, in world metres. */
  part: SupportPart;
  /** From the visual's position to the middle of the model, in the visual's own axes (default: none). */
  offset?: readonly [number, number, number];
}

export interface CollapseOptions {
  /** Most carriers dynamic at once (default 64). */
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
  /** A part fell: its building key and visual entity (for effects, tallies). */
  onFall?: (sim: SimWorld, building: string, eid: number) => void;
}

interface PartState {
  wid: bigint;
  colliders: bigint[];
  size: readonly [number, number, number];
  offset: readonly [number, number, number];
  /** Where the middle stood (world), for the carrier. */
  centre: readonly [number, number, number];
}

interface Building {
  key: string;
  graph: SupportGraph;
  parts: PartState[];
  /** Broken or already scheduled to fall: what the graph treats as gone. */
  gone: Set<number>;
}

interface Queued {
  building: Building;
  index: number;
  dueAt: number;
}

interface Falling {
  /** The visual entity and its carrier. */
  visual: bigint;
  carrier: bigint;
  offset: readonly [number, number, number];
  size: readonly [number, number, number];
  since: number;
  slowSince: number | null;
}

const SLOW_MS = 0.05;

/** `v` turned by the unit quaternion (x, y, z, w). */
function rotate(v: readonly [number, number, number], qx: number, qy: number, qz: number, qw: number): [number, number, number] {
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [v[0] + qw * tx + (qy * tz - qz * ty), v[1] + qw * ty + (qz * tx - qx * tz), v[2] + qw * tz + (qx * ty - qy * tx)];
}

export class CollapseSystem implements SimSystem {
  readonly name = "collapse";
  private readonly buildings = new Map<string, Building>();
  private readonly of = new Map<bigint, { building: Building; index: number }>();
  private queue: Queued[] = [];
  /** Buildings with parts broken since the last tick: each is worked out once per tick, however many parts broke in it. */
  private readonly dirty = new Set<Building>();
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

  /** Parts waiting to be released, carriers dynamic now, and parts let fall so far. */
  get stats(): { queued: number; active: number; fallen: number; buildings: number } {
    return { queued: this.queue.length, active: this.falling.length, fallen: this.fallen, buildings: this.buildings.size };
  }

  /** The carrier entity (wire id) of a part that is falling now, if any (for tests and effects). */
  carrierOf(visual: bigint): bigint | undefined {
    return this.falling.find((f) => f.visual === visual)?.carrier;
  }

  /**
   * Where a building part really is, for hitting it (DE4c): the model's middle (its pivot position plus the offset,
   * turned with it, so a part that has fallen is followed), and how far its box reaches. Undefined for anything that
   * is not a registered part. The pivot (the top of a wall) is not where a blow lands.
   */
  hitBody(sim: SimWorld, eid: number): { x: number; y: number; z: number; rx: number; ry: number } | undefined {
    const at = this.of.get(sim.wireId(eid));
    if (!at) return undefined;
    const part = at.building.parts[at.index]!;
    const T = Transform;
    const o = rotate(part.offset, T.qx[eid]!, T.qy[eid]!, T.qz[eid]!, T.qw[eid]!);
    return { x: T.px[eid]! + o[0], y: T.py[eid]! + o[1], z: T.pz[eid]! + o[2], rx: Math.min(3, Math.max(part.size[0], part.size[2]) / 2), ry: part.size[1] / 2 };
  }

  /** Register a building: its parts' entities and boxes. Builds its support graph once. */
  registerBuilding(sim: SimWorld, key: string, specs: readonly CollapsePartSpec[], o: SupportOptions = {}): SupportGraph {
    const graph = buildSupportGraph(specs.map((s) => s.part), o);
    const b: Building = {
      key,
      graph,
      gone: new Set(),
      parts: specs.map((s) => ({
        wid: sim.wireId(s.eid),
        colliders: s.colliders.map((c) => sim.wireId(c)),
        size: s.part.size,
        offset: s.offset ?? [0, 0, 0],
        centre: s.part.pos,
      })),
    };
    this.buildings.set(key, b);
    specs.forEach((s, index) => this.of.set(sim.wireId(s.eid), { building: b, index }));
    return graph;
  }

  /**
   * A part broke (or was taken out): its colliders go with it now, and what lost its support is worked out at the
   * next step (once per building however many of its parts broke: a demolition breaks dozens in one tick, and
   * working the graph out per part cost ~4 ms each on a 380-part building). Returns whether the part is known.
   */
  partBroken(sim: SimWorld, eid: number): boolean {
    const at = this.of.get(sim.wireId(eid));
    if (!at) return false;
    const { building, index } = at;
    if (building.gone.has(index)) return true;
    for (const c of building.parts[index]!.colliders) {
      const ce = sim.resolveWireId(c);
      if (ce >= 0) sim.despawn(ce);
    }
    building.gone.add(index);
    this.dirty.add(building);
    return true;
  }

  /** Work out what each building with broken parts lost, and queue it wave by wave. */
  private resolve(): void {
    for (const building of this.dirty) {
      for (const f of collapseFrom(building.graph, building.gone)) {
        building.gone.add(f.index);
        this.queue.push({ building, index: f.index, dueAt: this.now + f.wave * this.waveDelayS });
      }
    }
    this.dirty.clear();
  }

  step(sim: SimWorld, dtSeconds: number): void {
    this.now += dtSeconds;
    this.resolve();
    this.release(sim);
    this.follow(sim);
    this.settle(sim);
  }

  /** Take parts that are due off to physics, within the per-tick and active caps. */
  private release(sim: SimWorld): void {
    if (this.queue.length === 0) return;
    let released = 0;
    const waiting: Queued[] = [];
    this.queue.sort((a, b) => a.dueAt - b.dueAt);
    for (const q of this.queue) {
      if (q.dueAt > this.now || released >= this.perTick || this.falling.length >= this.maxActive) {
        waiting.push(q);
        continue;
      }
      released++;
      const part = q.building.parts[q.index]!;
      const visual = sim.resolveWireId(part.wid);
      if (visual < 0) continue; // broken and gone meanwhile
      for (const c of part.colliders) {
        const ce = sim.resolveWireId(c);
        if (ce >= 0) sim.despawn(ce);
      }
      const carrier = this.spawnCarrier(sim, part, visual, true);
      this.falling.push({ visual: part.wid, carrier: sim.wireId(carrier), offset: part.offset, size: part.size, since: this.now, slowSince: null });
      this.fallen++;
      this.opts.onFall?.(sim, q.building.key, visual);
    }
    this.queue = waiting;
  }

  /** A body-only entity at the part's middle: dynamic while it falls, static where it comes to rest. */
  private spawnCarrier(sim: SimWorld, part: { size: readonly [number, number, number]; centre: readonly [number, number, number] }, visual: number, dynamic: boolean, pose?: { px: number; py: number; pz: number; qx: number; qy: number; qz: number; qw: number }): number {
    const e = sim.spawn();
    addComponent(sim.ecs, Transform, e);
    const T = Transform;
    if (pose) {
      T.px[e] = pose.px; T.py[e] = pose.py; T.pz[e] = pose.pz;
      T.qx[e] = pose.qx; T.qy[e] = pose.qy; T.qz[e] = pose.qz; T.qw[e] = pose.qw;
    } else {
      T.px[e] = part.centre[0]; T.py[e] = part.centre[1]; T.pz[e] = part.centre[2];
      T.qx[e] = Transform.qx[visual]!; T.qy[e] = Transform.qy[visual]!; T.qz[e] = Transform.qz[visual]!; T.qw[e] = Transform.qw[visual]!;
    }
    T.sx[e] = T.sy[e] = T.sz[e] = 1;
    addComponent(sim.ecs, AssetRef, e);
    AssetRef.assetHash[e] = COLLIDER_HASH;
    AssetRef.variant[e] = 0;
    addComponent(sim.ecs, Velocity, e);
    Velocity.lx[e] = Velocity.ly[e] = Velocity.lz[e] = 0;
    Velocity.ax[e] = Velocity.ay[e] = Velocity.az[e] = 0;
    addComponent(sim.ecs, BodyConfig, e);
    const B = BodyConfig;
    B.shapeKind[e] = ShapeKind.Box;
    B.halfX[e] = Math.max(0.05, part.size[0] / 2);
    B.halfY[e] = Math.max(0.05, part.size[1] / 2);
    B.halfZ[e] = Math.max(0.05, part.size[2] / 2);
    B.radius[e] = 0;
    B.friction[e] = 0.8;
    if (dynamic) {
      B.restitution[e] = 0.1;
      B.mass[e] = Math.min(2000, Math.max(5, 8 * B.halfX[e]! * B.halfY[e]! * B.halfZ[e]! * this.density));
      B.motionType[e] = MotionType.Dynamic;
      B.layer[e] = 1;
    } else {
      B.restitution[e] = 0;
      B.mass[e] = 0;
      B.motionType[e] = MotionType.Static;
      B.layer[e] = 0;
    }
    return e;
  }

  /** Put each falling visual where its carrier says: the carrier's middle, less the pivot offset turned with it. */
  private follow(sim: SimWorld): void {
    for (const f of this.falling) this.place(sim, f);
  }

  private place(sim: SimWorld, f: Falling): void {
    const v = sim.resolveWireId(f.visual);
    const c = sim.resolveWireId(f.carrier);
    if (v < 0 || c < 0) return;
    const T = Transform;
    const o = rotate(f.offset, T.qx[c]!, T.qy[c]!, T.qz[c]!, T.qw[c]!);
    T.px[v] = T.px[c]! - o[0];
    T.py[v] = T.py[c]! - o[1];
    T.pz[v] = T.pz[c]! - o[2];
    T.qx[v] = T.qx[c]!; T.qy[v] = T.qy[c]!; T.qz[v] = T.qz[c]!; T.qw[v] = T.qw[c]!;
  }

  /** Freeze parts that have come to rest, or have been falling too long: a static carrier where it lies. */
  private settle(sim: SimWorld): void {
    if (this.falling.length === 0) return;
    const keep: Falling[] = [];
    for (const f of this.falling) {
      const c = sim.resolveWireId(f.carrier);
      const v = sim.resolveWireId(f.visual);
      if (c < 0 || v < 0) {
        if (c >= 0) sim.despawn(c);
        continue;
      }
      const speed = Math.hypot(Velocity.lx[c]!, Velocity.ly[c]!, Velocity.lz[c]!);
      if (speed < SLOW_MS) f.slowSince ??= this.now;
      else f.slowSince = null;
      const rested = f.slowSince !== null && this.now - f.slowSince >= this.settleS;
      if (!rested && this.now - f.since < this.maxAgeS) {
        keep.push(f);
        continue;
      }
      const T = Transform;
      const pose = { px: T.px[c]!, py: T.py[c]!, pz: T.pz[c]!, qx: T.qx[c]!, qy: T.qy[c]!, qz: T.qz[c]!, qw: T.qw[c]! };
      sim.despawn(c);
      this.spawnCarrier(sim, { size: f.size, centre: [pose.px, pose.py, pose.pz] }, v, false, pose);
    }
    this.falling = keep;
  }
}
