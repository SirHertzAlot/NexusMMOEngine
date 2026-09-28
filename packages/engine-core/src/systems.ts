/**
 * Simulation systems (slice 1.2, Phase 2 physics).
 *
 * SOLID: every system sits behind the narrow SimSystem interface —
 * name + step(world, dt). A future C++ addon (slice 1.6+) replaces a
 * system by implementing the same interface against the same component
 * stores (via shared buffers), without touching the tick loop or the
 * world. Systems never talk to each other directly; they communicate
 * through component data and the world's intent queue (EDA).
 *
 * DOD: queries are created once per system (not per tick); step() only
 * walks flat SoA arrays. No per-entity allocation on the hot path.
 *
 * Systems:
 * - IntentSystem: kinematic character control — PlayerIntent wish-move
 *   becomes Velocity. Any entity carrying PlayerIntent is player-driven;
 *   N such entities are handled identically (multiplayer by
 *   construction, no single-player assumption).
 * - IntegrateSystem: semi-implicit Euler — position += velocity * dt for
 *   Transform+Velocity entities WITHOUT BodyConfig. Entities carrying
 *   BodyConfig are owned by PhysicsSystem instead (never double-stepped).
 * - PhysicsSystem (Phase 2): drives the Jolt native addon behind the
 *   narrow PhysicsBackend interface. JS owns Transform, Velocity and
 *   BodyConfig; the native world owns the PhysicsSystem, the
 *   entity->BodyID map and the simulated state. Per tick:
 *     syncBodies (kinematic targets + teleports) -> step -> copyResults
 *   all in bulk SoA calls — no per-entity N-API on the hot path.
 *   The backend is injected (swappable): production passes the Jolt
 *   addon adapter (createJoltBackend), tests pass a mock.
 */

import { createRequire } from "node:module";
import { defineQuery, Not } from "bitecs";
import {
  BodyConfig,
  MotionType,
  PlayerIntent,
  Transform,
  Velocity,
} from "./components.js";
import type { SimWorld } from "./world.js";
import type { ChunkDataSource } from "./procgen/chunk-source.js";

export interface SimSystem {
  readonly name: string;
  /** Advance one fixed step. dtSeconds is the fixed step (STEP_MS/1000). */
  step(sim: SimWorld, dtSeconds: number): void;
}

/** Player movement speed in world units per second. */
export const PLAYER_SPEED = 6;

export class IntentSystem implements SimSystem {
  readonly name = "intent";
  private readonly query = defineQuery([PlayerIntent, Velocity]);

  step(sim: SimWorld, _dtSeconds: number): void {
    const eids = this.query(sim.ecs);
    for (let i = 0; i < eids.length; i++) {
      const e = eids[i] as number;
      // Horizontal axes only — the Y axis belongs to CharacterSystem
      // (gravity/jump/grounding). Writing ly here would wipe jump
      // velocity every tick (the client always sends my=0).
      Velocity.lx[e] = PlayerIntent.mx[e] * PLAYER_SPEED;
      Velocity.lz[e] = PlayerIntent.mz[e] * PLAYER_SPEED;
    }
  }
}

/** Initial upward velocity on jump, world units/second. */
export const JUMP_SPEED = 8;
/** Downward acceleration while airborne, world units/second^2. */
export const GRAVITY = 22;
/** Distance under which an entity counts as grounded (step tolerance). */
const GROUND_SNAP = 0.08;
/** Heightfields CharacterSystem keeps resident (~1 KiB each). */
const CHARACTER_HEIGHT_CACHE_CHUNKS = 64;

/**
 * Terrain surface height at chunk-local (lx, lz), matching the mirror's
 * rendered mesh exactly: a THREE.PlaneGeometry with 15x15 segments whose
 * vertex (i, j) sits at local (i, j) * chunkSize/15 with height
 * heights[j*16 + i]. PlaneGeometry splits every cell along the
 * anti-diagonal — triangles (i,j)-(i,j+1)-(i+1,j) and
 * (i,j+1)-(i+1,j+1)-(i+1,j) — so interpolate on whichever triangle
 * contains the point. Positions outside the chunk clamp to its edge.
 */
export function terrainHeightAt(
  heights: Float32Array,
  lx: number,
  lz: number,
  chunkSize: number,
): number {
  const S = 16;
  const cells = S - 1;
  const gx = Math.min(cells, Math.max(0, (lx * cells) / chunkSize));
  const gz = Math.min(cells, Math.max(0, (lz * cells) / chunkSize));
  const i = Math.min(cells - 1, Math.floor(gx));
  const j = Math.min(cells - 1, Math.floor(gz));
  const fx = gx - i;
  const fz = gz - j;
  const h00 = heights[j * S + i];
  const h10 = heights[j * S + i + 1];
  const h01 = heights[(j + 1) * S + i];
  const h11 = heights[(j + 1) * S + i + 1];
  if (fx + fz <= 1) {
    return h00 + fx * (h10 - h00) + fz * (h01 - h00);
  }
  return h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
}

export interface CharacterOptions {
  /** Authoritative heightfield source; absent -> flat ground at y=0. */
  chunkSource?: ChunkDataSource;
  /** World seed for heightfield sampling. */
  worldSeed?: bigint;
  /** Chunk edge length in world units. Default 16. */
  chunkSize?: number;
  /**
   * World edge, world units: players are held inside it (beyond it there
   * is no terrain to stand on). Default: unbounded.
   */
  bounds?: { minX: number; minZ: number; maxX: number; maxZ: number };
}

/**
 * CharacterSystem: server-authoritative kinematic character control —
 * gravity, jumping, and terrain grounding for player entities.
 *
 * Runs AFTER IntegrateSystem (it corrects the integrated Y position in
 * the same tick, so a landing entity never renders a frame sunk into
 * the terrain — the snapshot is collected after all systems run). It
 * owns the Y axis exclusively: IntentSystem only writes the horizontal
 * velocity axes. Jump fires on the rising edge of the intent's jump
 * flag while grounded; airborne entities accelerate downward; grounded
 * entities are glued to the terrain height so walking up slopes and
 * over bumps never floats or sinks.
 *
 * Ground comes from the authoritative ChunkDataSource, interpolated on
 * the exact triangles the mirror client renders (see terrainHeightAt),
 * so a character's feet sit on the visible surface everywhere — not
 * just at sample points. Without a source the ground is y=0 — the
 * client must never apply its own jump physics; it only sends the jump
 * flag upstream in PlayerIntent.
 */
export class CharacterSystem implements SimSystem {
  readonly name = "character";
  private readonly query = defineQuery([PlayerIntent, Velocity, Transform]);
  private readonly source: ChunkDataSource | null;
  private readonly worldSeed: bigint;
  private readonly chunkSize: number;
  private readonly bounds: CharacterOptions["bounds"] | null;
  /**
   * Per-chunk heightfields, keyed by packed (cx, cz). Bounded LRU: players
   * spread across chunks each hit their own entry instead of thrashing a
   * single slot (which re-ran native noise per player per tick).
   */
  private readonly heightCache = new Map<number, Float32Array>();
  /** Eids with jump held last tick — jump fires on the rising edge. */
  private readonly jumpHeld = new Set<number>();

  constructor(opts: CharacterOptions = {}) {
    this.source = opts.chunkSource ?? null;
    this.worldSeed = opts.worldSeed ?? 0n;
    this.chunkSize = opts.chunkSize ?? 16;
    this.bounds = opts.bounds ?? null;
  }

  /** Terrain height under world (x, z); y=0 without a source. */
  groundHeight(x: number, z: number): number {
    if (this.source === null) return 0;
    const cx = Math.floor(x / this.chunkSize);
    const cz = Math.floor(z / this.chunkSize);
    // Exact for |cx|, |cz| < 2^25 (far beyond float32 position precision).
    const key = (cx + 0x2000000) * 0x4000000 + (cz + 0x2000000);
    let heights = this.heightCache.get(key);
    if (heights !== undefined) {
      this.heightCache.delete(key); // refresh recency
    } else {
      heights = new Float32Array(this.source.chunkSamples);
      this.source.generateChunk(this.worldSeed, cx, cz, 0, heights);
      if (this.heightCache.size >= CHARACTER_HEIGHT_CACHE_CHUNKS) {
        this.heightCache.delete(this.heightCache.keys().next().value as number);
      }
    }
    this.heightCache.set(key, heights);
    return terrainHeightAt(
      heights,
      x - cx * this.chunkSize,
      z - cz * this.chunkSize,
      this.chunkSize,
    );
  }

  step(sim: SimWorld, dtSeconds: number): void {
    const eids = this.query(sim.ecs);
    // Drop held-state for entities that left the query (despawn/slot reuse).
    if (this.jumpHeld.size > eids.length) {
      const live = new Set<number>(eids as unknown as number[]);
      for (const e of this.jumpHeld) if (!live.has(e)) this.jumpHeld.delete(e);
    }
    const b = this.bounds;
    for (let k = 0; k < eids.length; k++) {
      const e = eids[k] as number;
      if (b) {
        // Just inside the edge: the last chunk's far side belongs to no chunk.
        Transform.px[e] = Math.min(b.maxX - 0.01, Math.max(b.minX, Transform.px[e]));
        Transform.pz[e] = Math.min(b.maxZ - 0.01, Math.max(b.minZ, Transform.pz[e]));
      }
      const ground = this.groundHeight(Transform.px[e], Transform.pz[e]);
      const grounded = Transform.py[e] <= ground + GROUND_SNAP;
      const wantJump = PlayerIntent.jump[e] !== 0;
      const held = this.jumpHeld.has(e);

      if (wantJump && !held && grounded) {
        Velocity.ly[e] = JUMP_SPEED;
      } else if (!grounded) {
        Velocity.ly[e] -= GRAVITY * dtSeconds;
      } else {
        // Grounded: kill downward velocity and glue to the terrain so
        // landing never hovers inside the snap tolerance and walking
        // stays planted on slopes.
        if (Velocity.ly[e] < 0) Velocity.ly[e] = 0;
        Transform.py[e] = ground;
      }

      if (wantJump) this.jumpHeld.add(e);
      else this.jumpHeld.delete(e);
    }
  }
}

export class IntegrateSystem implements SimSystem {
  readonly name = "integrate";
  // Physics-owned entities (BodyConfig) are stepped by PhysicsSystem;
  // integrating them here too would double-apply their motion.
  private readonly query = defineQuery([Transform, Velocity, Not(BodyConfig)]);

  step(sim: SimWorld, dtSeconds: number): void {
    const eids = this.query(sim.ecs);
    const P = Transform;
    const V = Velocity;
    for (let i = 0; i < eids.length; i++) {
      const e = eids[i] as number;
      P.px[e] += V.lx[e] * dtSeconds;
      P.py[e] += V.ly[e] * dtSeconds;
      P.pz[e] += V.lz[e] * dtSeconds;
    }
  }
}

// ------------------------------------------------------------ physics

/** Bulk add batch for PhysicsBackend.addBodies (SoA, sorted by wire id). */
export interface PhysicsAddBatch {
  count: number;
  entityIds: BigUint64Array;
  shapeKind: Uint8Array;
  halfExtents: Float32Array; // 3 * count
  radius: Float32Array;
  mass: Float32Array;
  friction: Float32Array;
  restitution: Float32Array;
  motionType: Uint8Array;
  layer: Uint8Array;
  pos: Float32Array; // 3 * count
  quat: Float32Array; // 4 * count, xyzw
  linVel: Float32Array; // 3 * count, initial linear velocity
  angVel: Float32Array; // 3 * count, initial angular velocity
}

/**
 * Narrow backend contract behind PhysicsSystem (DIP). One method per
 * native bulk op; the entity->BodyID map stays native and BodyIDs never
 * cross to JS — identity on this side is always the u64 wire id.
 */
export interface PhysicsBackend {
  readonly name: string;
  addBodies(batch: PhysicsAddBatch): void;
  removeBodies(entityIds: BigUint64Array): void;
  syncBodies(
    count: number,
    entityIds: BigUint64Array,
    pos: Float32Array,
    quat: Float32Array,
    linVel: Float32Array,
    angVel: Float32Array,
    flags: Uint8Array,
    dtSeconds: number,
  ): void;
  step(dtSeconds: number, subSteps: number): void;
  copyResults(
    count: number,
    entityIds: BigUint64Array,
    pos: Float32Array,
    quat: Float32Array,
    linVel: Float32Array,
    angVel: Float32Array,
  ): void;
  bodyCount(): number;
  destroy(): void;
  /**
   * Static terrain collision: one height-field body per chunk tile,
   * keyed by a chunk key (its own id space). Optional: mock backends
   * without terrain skip it. See addon-physics addTerrain.
   */
  addTerrain?(key: bigint, originX: number, originZ: number, spacing: number, samples: Float32Array, friction: number): boolean;
  removeTerrain?(key: bigint): void;
  terrainCount?(): number;
}

/** syncBodies flag: force-set a dynamic body's transform (respawns, restores). */
const SYNC_FLAG_TELEPORT = 0x01;

/**
 * PhysicsSystem — authoritative rigid-body simulation via an injected
 * PhysicsBackend (Jolt addon in production, mock in tests).
 *
 * Membership tracking: the native world is the source of truth for
 * which wire ids have bodies. Each tick the system diffs the current
 * [Transform, Velocity, BodyConfig] query against the previous tick's
 * sorted wire-id list (two-pointer merge — no allocation in steady
 * state) and issues bulk addBodies/removeBodies for the difference.
 * Adds are always issued in ascending wire-id order so the native
 * insertion order is deterministic across processes (Jolt is
 * deterministic given the same binary and the same mutating-API call
 * order).
 *
 * Motion-type handling per tick:
 * - kinematic: syncBodies every tick (JS-side Transform is the target;
 *   Jolt derives velocity from the frame delta),
 * - dynamic: left alone unless teleport() was called (explicit
 *   reposition: respawns, restores),
 * - static: never synced, never copied.
 * After step(), results are copied back into Transform (position +
 * quaternion) and Velocity (linear + angular) for dynamic and
 * kinematic bodies.
 */
export class PhysicsSystem implements SimSystem {
  readonly name = "physics";
  private readonly query = defineQuery([Transform, Velocity, BodyConfig]);
  private readonly teleports = new Set<bigint>();

  // Previous tick's membership, sorted by wire id (two rotating buffers).
  private prevA: bigint[] = [];
  private prevAEids: number[] = [];
  private prevB: bigint[] = [];
  private prevBEids: number[] = [];
  private prevSel = 0;

  // Scratch, grown geometrically and reused across ticks.
  private wid: bigint[] = [];
  private seid: number[] = [];
  private order = new Int32Array(0);
  private addIds = new BigUint64Array(0);
  private addShape = new Uint8Array(0);
  private addHalf = new Float32Array(0);
  private addRadius = new Float32Array(0);
  private addMass = new Float32Array(0);
  private addFriction = new Float32Array(0);
  private addRestitution = new Float32Array(0);
  private addMotion = new Uint8Array(0);
  private addLayer = new Uint8Array(0);
  private addPos = new Float32Array(0);
  private addQuat = new Float32Array(0);
  private addLin = new Float32Array(0);
  private addAng = new Float32Array(0);
  private readonly addDesc: PhysicsAddBatch = {
    count: 0,
    entityIds: this.addIds,
    shapeKind: this.addShape,
    halfExtents: this.addHalf,
    radius: this.addRadius,
    mass: this.addMass,
    friction: this.addFriction,
    restitution: this.addRestitution,
    motionType: this.addMotion,
    layer: this.addLayer,
    pos: this.addPos,
    quat: this.addQuat,
    linVel: this.addLin,
    angVel: this.addAng,
  };
  private remIds = new BigUint64Array(0);
  private syncIds = new BigUint64Array(0);
  private syncPos = new Float32Array(0);
  private syncQuat = new Float32Array(0);
  private syncZero = new Float32Array(0);
  private syncFlags = new Uint8Array(0);
  private copyIds = new BigUint64Array(0);
  private copyEids = new Int32Array(0);
  private copyPos = new Float32Array(0);
  private copyQuat = new Float32Array(0);
  private copyLin = new Float32Array(0);
  private copyAng = new Float32Array(0);

  /**
   * @param backend injected physics backend (Jolt addon or mock).
   * @param subSteps Jolt substeps per tick (fixed-timestep pattern:
   *   dt/subSteps per Update, one collision step each). Default 2.
   */
  constructor(
    private readonly backend: PhysicsBackend,
    private readonly subSteps = 2,
  ) {}

  /**
   * Mark an entity for teleport on the next tick: its JS-side
   * Transform is force-set into the native body (respawns, restores).
   * Only meaningful for dynamic bodies; harmless otherwise.
   */
  teleport(sim: SimWorld, eid: number): void {
    this.teleports.add(sim.wireId(eid));
  }

  /** Shut the backend down explicitly (native world teardown). */
  close(): void {
    this.backend.destroy();
  }

  /**
   * Terrain collision for streamed chunks (a ChunkStreamer `colliders`
   * hook): each loaded chunk's tile becomes a static height field, so
   * physics bodies rest on the same surface characters walk on and
   * clients render. A no-op when the backend has no terrain support.
   */
  terrainColliders(chunkWorldSize: number, friction = 0.8): {
    add(cx: number, cz: number, heights: Float32Array): void;
    remove(cx: number, cz: number): void;
  } {
    const key = (cx: number, cz: number): bigint =>
      (BigInt.asUintN(32, BigInt(cx)) << 32n) | BigInt.asUintN(32, BigInt(cz));
    return {
      add: (cx, cz, heights) => {
        if (!this.backend.addTerrain) return;
        // Samples span the chunk edge to edge (neighbours share borders).
        const spacing = chunkWorldSize / (Math.sqrt(heights.length) - 1);
        if (!this.backend.addTerrain(key(cx, cz), cx * chunkWorldSize, cz * chunkWorldSize, spacing, heights, friction)) {
          throw new Error(`physics: terrain collider for chunk ${cx},${cz} was rejected`);
        }
      },
      remove: (cx, cz) => this.backend.removeTerrain?.(key(cx, cz)),
    };
  }

  step(sim: SimWorld, dtSeconds: number): void {
    const B = BodyConfig;
    const T = Transform;
    const V = Velocity;

    const eids = this.query(sim.ecs);
    const n = eids.length;
    const prevIds = this.prevSel === 0 ? this.prevA : this.prevB;
    const prevEids = this.prevSel === 0 ? this.prevAEids : this.prevBEids;
    if (n === 0 && prevIds.length === 0) return;
    this.ensure(n);

    // Current membership, sorted by wire id (ascending => deterministic
    // native insertion order regardless of bitECS query order).
    const wid = this.wid;
    const seid = this.seid;
    const order = this.order;
    for (let i = 0; i < n; i++) {
      const e = eids[i] as number;
      wid[i] = sim.wireId(e);
      seid[i] = e;
      order[i] = i;
    }
    order.subarray(0, n).sort((a, b) => (wid[a] < wid[b] ? -1 : wid[a] > wid[b] ? 1 : 0));

    // Two-pointer merge against the previous tick: adds (with full
    // BodyConfig SoA) and removals, both in ascending wire-id order.
    const nextIds = this.prevSel === 0 ? this.prevB : this.prevA;
    const nextEids = this.prevSel === 0 ? this.prevBEids : this.prevAEids;
    nextIds.length = 0;
    nextEids.length = 0;
    let a = 0;
    let b = 0;
    let addN = 0;
    let remN = 0;
    while (a < prevIds.length && b < n) {
      const pw = prevIds[a];
      const cw = wid[order[b]];
      if (pw === cw) {
        nextIds.push(pw);
        nextEids.push(seid[order[b]]);
        a++;
        b++;
      } else if (pw < cw) {
        this.remIds[remN++] = pw;
        a++;
      } else {
        // New entity: bulk-add AND join the live set (it simulates
        // from this tick on).
        nextIds.push(cw);
        nextEids.push(seid[order[b]]);
        this.writeAdd(seid[order[b]], cw, addN++);
        b++;
      }
    }
    while (a < prevIds.length) this.remIds[remN++] = prevIds[a++];
    while (b < n) {
      const e = seid[order[b]];
      const w = wid[order[b]];
      nextIds.push(w);
      nextEids.push(e);
      this.writeAdd(e, w, addN++);
      b++;
    }

    if (addN > 0) {
      this.addDesc.count = addN;
      this.backend.addBodies(this.addDesc);
    }
    if (remN > 0) {
      this.backend.removeBodies(this.remIds.subarray(0, remN));
    }
    prevIds.length = 0;
    prevEids.length = 0;
    this.prevSel ^= 1;

    // Sync: kinematic bodies follow the JS-side transform every tick;
    // dynamic bodies only when teleported. Static bodies are skipped.
    let syncN = 0;
    const teleports = this.teleports;
    for (let w = 0; w < nextIds.length; w++) {
      const e = nextEids[w];
      const mt = B.motionType[e];
      const isTele = teleports.has(nextIds[w]);
      if (mt === MotionType.Kinematic || (mt === MotionType.Dynamic && isTele)) {
        this.syncIds[syncN] = nextIds[w];
        this.syncPos[syncN * 3] = T.px[e];
        this.syncPos[syncN * 3 + 1] = T.py[e];
        this.syncPos[syncN * 3 + 2] = T.pz[e];
        this.syncQuat[syncN * 4] = T.qx[e];
        this.syncQuat[syncN * 4 + 1] = T.qy[e];
        this.syncQuat[syncN * 4 + 2] = T.qz[e];
        this.syncQuat[syncN * 4 + 3] = T.qw[e];
        this.syncFlags[syncN] = isTele ? SYNC_FLAG_TELEPORT : 0;
        syncN++;
      }
    }
    teleports.clear();
    if (syncN > 0) {
      this.backend.syncBodies(
        syncN,
        this.syncIds.subarray(0, syncN),
        this.syncPos.subarray(0, syncN * 3),
        this.syncQuat.subarray(0, syncN * 4),
        this.syncZero.subarray(0, syncN * 3),
        this.syncZero.subarray(0, syncN * 3),
        this.syncFlags.subarray(0, syncN),
        dtSeconds,
      );
    }

    this.backend.step(dtSeconds, this.subSteps);

    // Copy results back into Transform + Velocity for simulated bodies.
    let copyN = 0;
    for (let w = 0; w < nextIds.length; w++) {
      const e = nextEids[w];
      if (B.motionType[e] === MotionType.Static) continue;
      this.copyIds[copyN] = nextIds[w];
      this.copyEids[copyN] = e;
      copyN++;
    }
    if (copyN > 0) {
      this.backend.copyResults(
        copyN,
        this.copyIds.subarray(0, copyN),
        this.copyPos.subarray(0, copyN * 3),
        this.copyQuat.subarray(0, copyN * 4),
        this.copyLin.subarray(0, copyN * 3),
        this.copyAng.subarray(0, copyN * 3),
      );
      for (let k = 0; k < copyN; k++) {
        const e = this.copyEids[k];
        T.px[e] = this.copyPos[k * 3];
        T.py[e] = this.copyPos[k * 3 + 1];
        T.pz[e] = this.copyPos[k * 3 + 2];
        T.qx[e] = this.copyQuat[k * 4];
        T.qy[e] = this.copyQuat[k * 4 + 1];
        T.qz[e] = this.copyQuat[k * 4 + 2];
        T.qw[e] = this.copyQuat[k * 4 + 3];
        V.lx[e] = this.copyLin[k * 3];
        V.ly[e] = this.copyLin[k * 3 + 1];
        V.lz[e] = this.copyLin[k * 3 + 2];
        V.ax[e] = this.copyAng[k * 3];
        V.ay[e] = this.copyAng[k * 3 + 1];
        V.az[e] = this.copyAng[k * 3 + 2];
      }
    }
  }

  private writeAdd(e: number, id: bigint, k: number): void {
    const B = BodyConfig;
    const T = Transform;
    const V = Velocity;
    this.addIds[k] = id;
    this.addShape[k] = B.shapeKind[e];
    this.addHalf[k * 3] = B.halfX[e];
    this.addHalf[k * 3 + 1] = B.halfY[e];
    this.addHalf[k * 3 + 2] = B.halfZ[e];
    this.addRadius[k] = B.radius[e];
    this.addMass[k] = B.mass[e];
    this.addFriction[k] = B.friction[e];
    this.addRestitution[k] = B.restitution[e];
    this.addMotion[k] = B.motionType[e];
    this.addLayer[k] = B.layer[e];
    this.addPos[k * 3] = T.px[e];
    this.addPos[k * 3 + 1] = T.py[e];
    this.addPos[k * 3 + 2] = T.pz[e];
    this.addQuat[k * 4] = T.qx[e];
    this.addQuat[k * 4 + 1] = T.qy[e];
    this.addQuat[k * 4 + 2] = T.qz[e];
    this.addQuat[k * 4 + 3] = T.qw[e];
    this.addLin[k * 3] = V.lx[e];
    this.addLin[k * 3 + 1] = V.ly[e];
    this.addLin[k * 3 + 2] = V.lz[e];
    this.addAng[k * 3] = V.ax[e];
    this.addAng[k * 3 + 1] = V.ay[e];
    this.addAng[k * 3 + 2] = V.az[e];
  }

  /** Grow scratch buffers to hold n entities (geometric growth). */
  private ensure(n: number): void {
    if (this.wid.length >= n && this.order.length >= n) return;
    const cap = Math.max(16, n * 2);
    this.wid = new Array(cap);
    this.seid = new Array(cap);
    this.order = new Int32Array(cap);
    this.addIds = new BigUint64Array(cap);
    this.addShape = new Uint8Array(cap);
    this.addHalf = new Float32Array(cap * 3);
    this.addRadius = new Float32Array(cap);
    this.addMass = new Float32Array(cap);
    this.addFriction = new Float32Array(cap);
    this.addRestitution = new Float32Array(cap);
    this.addMotion = new Uint8Array(cap);
    this.addLayer = new Uint8Array(cap);
    this.addPos = new Float32Array(cap * 3);
    this.addQuat = new Float32Array(cap * 4);
    this.addLin = new Float32Array(cap * 3);
    this.addAng = new Float32Array(cap * 3);
    this.remIds = new BigUint64Array(cap);
    this.syncIds = new BigUint64Array(cap);
    this.syncPos = new Float32Array(cap * 3);
    this.syncQuat = new Float32Array(cap * 4);
    this.syncZero = new Float32Array(cap * 3);
    this.syncFlags = new Uint8Array(cap);
    this.copyIds = new BigUint64Array(cap);
    this.copyEids = new Int32Array(cap);
    this.copyPos = new Float32Array(cap * 3);
    this.copyQuat = new Float32Array(cap * 4);
    this.copyLin = new Float32Array(cap * 3);
    this.copyAng = new Float32Array(cap * 3);
    this.addDesc.entityIds = this.addIds;
    this.addDesc.shapeKind = this.addShape;
    this.addDesc.halfExtents = this.addHalf;
    this.addDesc.radius = this.addRadius;
    this.addDesc.mass = this.addMass;
    this.addDesc.friction = this.addFriction;
    this.addDesc.restitution = this.addRestitution;
    this.addDesc.motionType = this.addMotion;
    this.addDesc.layer = this.addLayer;
    this.addDesc.pos = this.addPos;
    this.addDesc.quat = this.addQuat;
    this.addDesc.linVel = this.addLin;
    this.addDesc.angVel = this.addAng;
  }
}

// ------------------------------------------------------ Jolt backend

interface JoltAddonModule {
  createWorld(): {
    addBodies(desc: unknown): void;
    removeBodies(entityIds: BigUint64Array): void;
    syncBodies(
      count: number,
      entityIds: BigUint64Array,
      pos: Float32Array,
      quat: Float32Array,
      linVel: Float32Array,
      angVel: Float32Array,
      flags: Uint8Array,
      dt: number,
    ): void;
    step(dt: number, subSteps: number): void;
    copyResults(
      count: number,
      entityIds: BigUint64Array,
      pos: Float32Array,
      quat: Float32Array,
      linVel: Float32Array,
      angVel: Float32Array,
    ): void;
    bodyCount(): number;
    destroy(): void;
    addTerrain(key: bigint, originX: number, originZ: number, spacing: number, samples: Float32Array, friction: number): boolean;
    removeTerrain(key: bigint): void;
    terrainCount(): number;
  };
  ShapeKind: { Box: 0; Sphere: 1 };
  MotionType: { Static: 0; Kinematic: 1; Dynamic: 2 };
  SyncFlags: { None: 0; Teleport: 0x01 };
}

/**
 * PhysicsBackend adapter over @mmo-engine/addon-physics (Jolt).
 *
 * The addon is a CJS native binding; require keeps ESM/CJS interop
 * simple (same pattern as the procgen chunk source). Loaded lazily —
 * importing systems.ts never touches the native module, so unit tests
 * with a mock backend stay build-free.
 */
export function createJoltBackend(): PhysicsBackend {
  const require = createRequire(import.meta.url);
  const addon = require("@mmo-engine/addon-physics") as JoltAddonModule;
  const world = addon.createWorld();
  return {
    name: "jolt",
    addBodies: (batch) => world.addBodies(batch),
    removeBodies: (entityIds) => world.removeBodies(entityIds),
    syncBodies: (count, entityIds, pos, quat, linVel, angVel, flags, dt) =>
      world.syncBodies(count, entityIds, pos, quat, linVel, angVel, flags, dt),
    step: (dt, subSteps) => world.step(dt, subSteps),
    copyResults: (count, entityIds, pos, quat, linVel, angVel) =>
      world.copyResults(count, entityIds, pos, quat, linVel, angVel),
    bodyCount: () => world.bodyCount(),
    destroy: () => world.destroy(),
    addTerrain: (key, originX, originZ, spacing, samples, friction) =>
      world.addTerrain(key, originX, originZ, spacing, samples, friction),
    removeTerrain: (key) => world.removeTerrain(key),
    terrainCount: () => world.terrainCount(),
  };
}
