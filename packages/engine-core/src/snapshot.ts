/**
 * Snapshot & Delta codecs (slice 1.2, skill brief §6).
 *
 * Framing (packages/schema/mmo_engine.fbs):
 * - Snapshot: tick + one entity-ID-aligned block per component
 *   (Transform/velocity/intent/chunk/health), each block = parallel
 *   entity_ids[] + entries[] arrays.
 * - Delta: tick + base_tick + spawned[]/despawned[] + the same blocks,
 *   containing only changed (or spawned) entities.
 *
 * Row structs below are plain data (no FlatBuffers types leak out of
 * the encode/decode boundary). The FlatBuffers builders borrow their
 * generated bindings from @mmo-engine/schema's compiled output
 * (packages/schema/generated/js) — the schema stays the single source
 * of truth; this module only maps SoA rows <-> wire tables.
 *
 * DeltaTracker implements changed-only deltas: it keeps a Float64 copy
 * of every tracked field (sized to maxSlotSeen+1, not the full bitECS
 * store allocation), diffs against it per tick, and commits the new
 * baseline after the delta is built. Protocol:
 *   collectFullState(sim, 0) -> encodeSnapshot -> tracker.commit(sim)
 *   ... per tick: beginTick, systems, collectDeltaState(sim, tick,
 *   tick-1, tracker) -> encodeDelta -> tracker.commit(sim), endTick
 * Spawned-this-tick entities are always fully included (their baseline
 * is empty by construction), and generations on wire ids make slot
 * reuse unambiguous.
 */

import { defineQuery, hasComponent, type Query } from "bitecs";
import * as C from "./components.js";
import { joinU64 } from "./components.js";
import { parseWireEntityId } from "./entity-id.js";
import type { SimWorld } from "./world.js";
import {
  chunkCoordsFor,
  type ChunkDataSource,
} from "./procgen/chunk-source.js";

// ---------------------------------------------------------------- rows

// ------------------------------------------------------------ rows
//
// Row interfaces and CollectedState live in @mmo-engine/protocol's codec
// (packages/protocol/src/codec.ts) — the wire format belongs to the
// protocol package so the mirror client can share it without depending
// on the sim. Imported for local use and re-exported so existing
// engine-core imports keep working (DRY: one definition).
import type {
  ActionRow,
  AppearanceRow,
  AssetRefRow,
  BodyConfigRow,
  ChunkRow,
  CollectedState,
  HealthRow,
  CharacterRefRow,
  IntentRow,
  LocomotionRow,
  StaminaRow,
  TransformRow,
  VelocityRow,
} from "@mmo-engine/protocol";
export type {
  ActionRow,
  AppearanceRow,
  AssetRefRow,
  BodyConfigRow,
  ChunkRow,
  CollectedState,
  HealthRow,
  CharacterRefRow,
  IntentRow,
  LocomotionRow,
  StaminaRow,
  TransformRow,
  VelocityRow,
} from "@mmo-engine/protocol";
// ------------------------------------------------------------ collection

const qTransform: Query = defineQuery([C.Transform]);
const qVelocity: Query = defineQuery([C.Velocity]);
const qIntent: Query = defineQuery([C.PlayerIntent]);
const qChunk: Query = defineQuery([C.Chunk]);
const qHealth: Query = defineQuery([C.Health]);
const qStamina: Query = defineQuery([C.Stamina]);
const qBody: Query = defineQuery([C.BodyConfig]);
const qAssets: Query = defineQuery([C.AssetRef]);
const qLocomotion: Query = defineQuery([C.Locomotion]);
const qAppearance: Query = defineQuery([C.Appearance]);
const qAction: Query = defineQuery([C.Action]);
const qCharacterRef: Query = defineQuery([C.CharacterRef]);

function readTransform(sim: SimWorld, eid: number): TransformRow {
  const T = C.Transform;
  return {
    wireId: sim.wireId(eid),
    px: T.px[eid], py: T.py[eid], pz: T.pz[eid],
    qx: T.qx[eid], qy: T.qy[eid], qz: T.qz[eid], qw: T.qw[eid],
    sx: T.sx[eid], sy: T.sy[eid], sz: T.sz[eid],
  };
}

function readVelocity(sim: SimWorld, eid: number): VelocityRow {
  const V = C.Velocity;
  return {
    wireId: sim.wireId(eid),
    lx: V.lx[eid], ly: V.ly[eid], lz: V.lz[eid],
    ax: V.ax[eid], ay: V.ay[eid], az: V.az[eid],
  };
}

function readIntent(sim: SimWorld, eid: number): IntentRow {
  const I = C.PlayerIntent;
  return {
    wireId: sim.wireId(eid),
    mx: I.mx[eid], my: I.my[eid], mz: I.mz[eid],
    lookYaw: I.lookYaw[eid], lookPitch: I.lookPitch[eid],
    jump: I.jump[eid] !== 0, buttons: I.buttons[eid],
  };
}

function readChunk(sim: SimWorld, eid: number): ChunkRow {
  const K = C.Chunk;
  return {
    wireId: sim.wireId(eid),
    chunkId: joinU64(K.chunkIdHi[eid], K.chunkIdLo[eid]),
    seed: joinU64(K.seedHi[eid], K.seedLo[eid]),
    lod: K.lod[eid],
    // Network-only: filled by attachChunkHeights before encodeSnapshot /
    // encodeDelta on the gateway path. The persistence path (SnapshotStore)
    // never attaches — heights stay regenerable, snapshots stay small.
    heights: null,
  };
}

/**
 * Fill `heights` on every chunk row of an already-collected state, from
 * the authoritative ChunkDataSource. Call on the gateway's network path
 * (welcome / periodic snapshots, deltas carrying new chunks) — never on
 * the persistence path.
 */
export function attachChunkHeights(
  state: CollectedState,
  source: ChunkDataSource,
): void {
  for (const c of state.chunks) {
    const { cx, cz } = chunkCoordsFor(c.chunkId);
    const out = new Float32Array(source.chunkSamples);
    source.generateChunk(c.seed, cx, cz, c.lod, out);
    c.heights = out;
  }
}

function readHealth(sim: SimWorld, eid: number): HealthRow {
  const H = C.Health;
  return { wireId: sim.wireId(eid), current: H.current[eid], max: H.max[eid] };
}

function readStamina(sim: SimWorld, eid: number): StaminaRow {
  const S = C.Stamina;
  return { wireId: sim.wireId(eid), current: S.current[eid], max: S.max[eid] };
}

function readBodyConfig(sim: SimWorld, eid: number): BodyConfigRow {
  const B = C.BodyConfig;
  return {
    wireId: sim.wireId(eid),
    shapeKind: B.shapeKind[eid],
    halfX: B.halfX[eid], halfY: B.halfY[eid], halfZ: B.halfZ[eid],
    radius: B.radius[eid],
    mass: B.mass[eid],
    motionType: B.motionType[eid],
    layer: B.layer[eid],
    friction: B.friction[eid],
    restitution: B.restitution[eid],
  };
}

function readAssetRef(sim: SimWorld, eid: number): AssetRefRow {
  const A = C.AssetRef;
  return {
    wireId: sim.wireId(eid),
    assetHash: A.assetHash[eid],
    variant: A.variant[eid],
  };
}

function readLocomotion(sim: SimWorld, eid: number): LocomotionRow {
  const L = C.Locomotion;
  return { wireId: sim.wireId(eid), mode: L.mode[eid], abilities: L.abilities[eid], breath: L.breath[eid] };
}

function readAppearance(sim: SimWorld, eid: number): AppearanceRow {
  return { wireId: sim.wireId(eid), look: sim.lookJson(C.Appearance.look[eid]) };
}

function readAction(sim: SimWorld, eid: number): ActionRow {
  const A = C.Action;
  return { wireId: sim.wireId(eid), move: A.move[eid], started: A.started[eid], seq: A.seq[eid], yaw: A.yaw[eid] };
}

function readCharacterRef(sim: SimWorld, eid: number): CharacterRefRow {
  const R = C.CharacterRef;
  return { wireId: sim.wireId(eid), characterId: R.idHi[eid] * 4294967296 + R.idLo[eid] };
}

/** Collect the full state of every entity carrying each component. */
export function collectFullState(sim: SimWorld, tick: number): CollectedState {
  return {
    tick,
    baseTick: 0,
    transforms: qTransform(sim.ecs).map((e) => readTransform(sim, e)),
    velocities: qVelocity(sim.ecs).map((e) => readVelocity(sim, e)),
    intents: qIntent(sim.ecs).map((e) => readIntent(sim, e)),
    chunks: qChunk(sim.ecs).map((e) => readChunk(sim, e)),
    healths: qHealth(sim.ecs).map((e) => readHealth(sim, e)),
    bodies: qBody(sim.ecs).map((e) => readBodyConfig(sim, e)),
    assets: qAssets(sim.ecs).map((e) => readAssetRef(sim, e)),
    locomotions: qLocomotion(sim.ecs).map((e) => readLocomotion(sim, e)),
    appearances: qAppearance(sim.ecs).map((e) => readAppearance(sim, e)),
    actions: qAction(sim.ecs).map((e) => readAction(sim, e)),
    staminas: qStamina(sim.ecs).map((e) => readStamina(sim, e)),
    characterRefs: qCharacterRef(sim.ecs).map((e) => readCharacterRef(sim, e)),
    spawned: [...sim.spawnedWireIds()],
    despawned: [...sim.despawnedWireIds()],
  };
}

/**
 * Collect the full rows of just these entities (an unloading chunk's
 * contents, see ChunkEntityStore). No spawned/despawned lists: this is
 * stored state, not a change.
 */
export function collectEntitiesState(sim: SimWorld, eids: readonly number[], tick: number): CollectedState {
  const having = (component: Parameters<typeof hasComponent>[1]): number[] =>
    eids.filter((e) => hasComponent(sim.ecs, component, e));
  return {
    tick,
    baseTick: 0,
    transforms: having(C.Transform).map((e) => readTransform(sim, e)),
    velocities: having(C.Velocity).map((e) => readVelocity(sim, e)),
    intents: having(C.PlayerIntent).map((e) => readIntent(sim, e)),
    chunks: having(C.Chunk).map((e) => readChunk(sim, e)),
    healths: having(C.Health).map((e) => readHealth(sim, e)),
    bodies: having(C.BodyConfig).map((e) => readBodyConfig(sim, e)),
    assets: having(C.AssetRef).map((e) => readAssetRef(sim, e)),
    locomotions: having(C.Locomotion).map((e) => readLocomotion(sim, e)),
    appearances: having(C.Appearance).map((e) => readAppearance(sim, e)),
    actions: having(C.Action).map((e) => readAction(sim, e)),
    staminas: having(C.Stamina).map((e) => readStamina(sim, e)),
    characterRefs: having(C.CharacterRef).map((e) => readCharacterRef(sim, e)),
    spawned: [],
    despawned: [],
  };
}

// ---------------------------------------------------------- delta diff

type DiffKey = "transforms" | "velocities" | "intents" | "chunks" | "healths" | "staminas" | "bodies" | "assets" | "locomotions" | "appearances" | "actions" | "characterRefs";

interface TrackedComponent {
  key: DiffKey;
  query: Query;
  stores: Record<string, ArrayLike<number>>;
  fields: string[];
}

const TRACKED: TrackedComponent[] = [
  {
    key: "transforms", query: qTransform,
    stores: C.Transform as unknown as Record<string, ArrayLike<number>>,
    fields: ["px", "py", "pz", "qx", "qy", "qz", "qw", "sx", "sy", "sz"],
  },
  {
    key: "velocities", query: qVelocity,
    stores: C.Velocity as unknown as Record<string, ArrayLike<number>>,
    fields: ["lx", "ly", "lz", "ax", "ay", "az"],
  },
  {
    key: "intents", query: qIntent,
    stores: C.PlayerIntent as unknown as Record<string, ArrayLike<number>>,
    fields: ["mx", "my", "mz", "lookYaw", "lookPitch", "jump", "buttons"],
  },
  {
    key: "chunks", query: qChunk,
    stores: C.Chunk as unknown as Record<string, ArrayLike<number>>,
    fields: ["chunkIdHi", "chunkIdLo", "seedHi", "seedLo", "lod"],
  },
  {
    key: "healths", query: qHealth,
    stores: C.Health as unknown as Record<string, ArrayLike<number>>,
    fields: ["current", "max"],
  },
  {
    key: "staminas", query: qStamina,
    stores: C.Stamina as unknown as Record<string, ArrayLike<number>>,
    fields: ["current", "max"],
  },
  {
    key: "bodies", query: qBody,
    stores: C.BodyConfig as unknown as Record<string, ArrayLike<number>>,
    fields: ["shapeKind", "halfX", "halfY", "halfZ", "radius", "mass",
      "motionType", "layer", "friction", "restitution"],
  },
  {
    // Spawn-time config: written once at scatter spawn, never mutated.
    // Rides the spawnedSlots fast path into deltas; zero per-tick churn.
    key: "assets", query: qAssets,
    stores: C.AssetRef as unknown as Record<string, ArrayLike<number>>,
    fields: ["assetHash", "variant"],
  },
  {
    key: "locomotions", query: qLocomotion,
    stores: C.Locomotion as unknown as Record<string, ArrayLike<number>>,
    fields: ["mode", "abilities", "breath"],
  },
  {
    // Configuration: a look id changes only when the look does.
    key: "appearances", query: qAppearance,
    stores: C.Appearance as unknown as Record<string, ArrayLike<number>>,
    fields: ["look"],
  },
  {
    key: "actions", query: qAction,
    stores: C.Action as unknown as Record<string, ArrayLike<number>>,
    fields: ["move", "started", "seq", "yaw"],
  },
  {
    // Configuration: a character ref never changes after spawn.
    key: "characterRefs", query: qCharacterRef,
    stores: C.CharacterRef as unknown as Record<string, ArrayLike<number>>,
    fields: ["idHi", "idLo"],
  },
];

export interface DiffResult {
  transforms: number[];
  velocities: number[];
  intents: number[];
  chunks: number[];
  healths: number[];
  staminas: number[];
  bodies: number[];
  assets: number[];
  locomotions: number[];
  appearances: number[];
  actions: number[];
  characterRefs: number[];
}

/**
 * Changed-only diff against the last commit(). Keeps one Float64 copy
 * per tracked field, sized to maxSlotSeen+1 (not the full bitECS
 * allocation). commit() must run once after the initial snapshot to
 * establish the baseline — before that, everything reads as changed.
 *
 * Hot path (every tick, every entity): baselines live in plain arrays
 * indexed [component][field] and are resolved ONCE per component per
 * tick, so the inner loop is a direct typed-array compare. (Building a
 * "key.field" string and hashing it per entity per field cost ~27 ms/tick
 * at 10k entities — the whole tick budget.)
 */
export class DeltaTracker {
  private readonly prev: Float64Array[][] = TRACKED.map((t) =>
    t.fields.map(() => new Float64Array(0)),
  );

  /** This component's baselines, grown (never shrunk) to cover `bound` slots. */
  private baselines(ti: number, bound: number): Float64Array[] {
    const row = this.prev[ti];
    for (let fi = 0; fi < row.length; fi++) {
      if (row[fi].length < bound) {
        const grown = new Float64Array(bound);
        grown.set(row[fi]);
        row[fi] = grown;
      }
    }
    return row;
  }

  /**
   * Slot eids whose tracked fields changed since the last commit.
   * Slots in spawnedSlots are always included (fresh baseline).
   */
  diff(sim: SimWorld, spawnedSlots: Set<number>): DiffResult {
    const bound = sim.maxSlotSeen + 1;
    const out: DiffResult = {
      transforms: [], velocities: [], intents: [], chunks: [], healths: [],
      staminas: [],
      bodies: [], assets: [], locomotions: [], appearances: [], actions: [], characterRefs: [],
    };
    for (let ti = 0; ti < TRACKED.length; ti++) {
      const t = TRACKED[ti];
      const changed = out[t.key];
      const eids = t.query(sim.ecs);
      if (eids.length === 0) continue;
      const prevs = this.baselines(ti, bound);
      const stores = t.fields.map((f) => t.stores[f]);
      const nf = stores.length;
      for (let i = 0; i < eids.length; i++) {
        const eid = eids[i];
        if (spawnedSlots.size !== 0 && spawnedSlots.has(eid)) {
          changed.push(eid);
          continue;
        }
        for (let fi = 0; fi < nf; fi++) {
          if (stores[fi][eid] !== prevs[fi][eid]) {
            changed.push(eid);
            break;
          }
        }
      }
    }
    return out;
  }

  /** Copy current field values into the baseline. */
  commit(sim: SimWorld): void {
    const bound = sim.maxSlotSeen + 1;
    for (let ti = 0; ti < TRACKED.length; ti++) {
      const t = TRACKED[ti];
      const prevs = this.baselines(ti, bound);
      for (let fi = 0; fi < t.fields.length; fi++) {
        const store = t.stores[t.fields[fi]];
        const prev = prevs[fi];
        const n = Math.min(bound, store.length);
        if (ArrayBuffer.isView(store)) {
          // Native bulk copy (with numeric conversion) instead of a JS loop.
          prev.set((store as unknown as Float64Array).subarray(0, n));
        } else {
          for (let i = 0; i < n; i++) prev[i] = store[i];
        }
      }
    }
  }
}

/**
 * Collect a changed-only delta: component rows for entities whose
 * fields differ from the tracker's baseline (plus spawned entities in
 * full), and the tick's spawned/despawned wire-id lists.
 */
export function collectDeltaState(
  sim: SimWorld,
  tick: number,
  baseTick: number,
  tracker: DeltaTracker,
): CollectedState {
  const spawnedSlots = new Set(
    [...sim.spawnedWireIds()].map((w) => parseWireEntityId(w).slot),
  );
  const d = tracker.diff(sim, spawnedSlots);
  return {
    tick,
    baseTick,
    transforms: d.transforms.map((e) => readTransform(sim, e)),
    velocities: d.velocities.map((e) => readVelocity(sim, e)),
    intents: d.intents.map((e) => readIntent(sim, e)),
    chunks: d.chunks.map((e) => readChunk(sim, e)),
    healths: d.healths.map((e) => readHealth(sim, e)),
    bodies: d.bodies.map((e) => readBodyConfig(sim, e)),
    assets: d.assets.map((e) => readAssetRef(sim, e)),
    locomotions: d.locomotions.map((e) => readLocomotion(sim, e)),
    appearances: d.appearances.map((e) => readAppearance(sim, e)),
    actions: d.actions.map((e) => readAction(sim, e)),
    staminas: d.staminas.map((e) => readStamina(sim, e)),
    characterRefs: d.characterRefs.map((e) => readCharacterRef(sim, e)),
    spawned: [...sim.spawnedWireIds()],
    despawned: [...sim.despawnedWireIds()],
  };
}

// -------------------------------------------------------------- encode
//
// Snapshot/Delta encoding lives in @mmo-engine/protocol's codec: encoding
// maps plain CollectedState rows to wire tables with no sim dependency,
// so the server (which collects) and test tooling (which builds fixtures)
// share one implementation (DRY). Re-exported here so existing
// engine-core imports keep working.
export {
  decodeDelta,
  decodeSnapshot,
  encodeDelta,
  encodeSnapshot,
} from "@mmo-engine/protocol";
