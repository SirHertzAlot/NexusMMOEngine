/**
 * Interest management, core side (IM3 of docs/superpowers/specs/2026-10-23-interest-management-design.md).
 *
 * Once per tick `SectorFrame` buckets the tracker's changed eids by the sector of their Transform
 * (sector.ts, 64 m) and encodes one Delta per sector that changed: its entities' changed rows, the
 * entities that moved in (all their rows), and those that moved out (in `despawned`). Entities with
 * no Transform, and terrain chunks, live in the global sector "g", which also carries the tick's real
 * spawn and despawn ids. A sector's full state is encoded lazily, once per tick, for clients entering
 * it. Each session's interest set (`interestSectors`) is the sectors within enterM of its avatar,
 * kept until past leaveM. The bytes are shared; a client's DeltaSet only copies them.
 *
 * ponytail: terrain chunks are global (sent to everyone, cheap: they almost never change); a chunk
 * ring of their own (spec `chunkM`) when terrain bytes show up in B7.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { defineQuery, hasComponent } from "bitecs";
import { DeltaSetKind, GLOBAL_SECTOR, type DeltaSetEntry } from "@mmo-engine/protocol";
import * as C from "../components.js";
import { encodeEidsFromSim, fullEidLists, spawnedSlotsOf, type DeltaTracker, type DiffResult, type SoAEidLists } from "../snapshot.js";
import type { SimWorld } from "../world.js";
import type { ChunkDataSource } from "../procgen/chunk-source.js";
import { SECTOR_SIZE } from "./sector.js";

export interface InterestRadii {
  enterM: number;
  leaveM: number;
  /** How far a FarVisible entity is seen (IM5), metres. Default 400. */
  farM?: number;
  /**
   * IM7 rate LOD: sectors kept only by hysteresis (beyond enterM) send a delta every this many ticks,
   * carrying the union of the changed rows since the last send. Unset: every tick (today's path).
   */
  outerEvery?: number;
}

export const DEFAULT_INTEREST: InterestRadii = { enterM: 96, leaveM: 128, farM: 400 };

const farVisibleQuery = defineQuery([C.FarVisible]);

/** Every FarVisible entity (IM5): seen by each session within farM, pinned rather than sectored. */
export function farVisibleOf(sim: SimWorld): readonly number[] {
  return farVisibleQuery(sim.ecs);
}

type Key = keyof SoAEidLists;
const KEYS: Array<[Exclude<Key, "positions">, object]> = [
  ["transforms", C.Transform], ["velocities", C.Velocity], ["intents", C.PlayerIntent], ["chunks", C.Chunk],
  ["healths", C.Health], ["staminas", C.Stamina], ["characterRefs", C.CharacterRef], ["bodies", C.BodyConfig],
  ["assets", C.AssetRef], ["locomotions", C.Locomotion], ["appearances", C.Appearance], ["actions", C.Action],
  ["animations", C.Animation],
];

/** The row kinds a rate-limited window merges: every tracked component plus position-only transforms. */
const RATE_KEYS: Key[] = [...KEYS.map(([k]) => k), "positions"];

const EMPTY_EIDS: readonly number[] = Object.freeze([]);
const EMPTY_BIGINT_LIST: readonly bigint[] = Object.freeze([]);

const emptyLists = (): Record<Key, number[]> => ({
  transforms: [], positions: [], velocities: [], intents: [], chunks: [], healths: [], staminas: [], characterRefs: [],
  bodies: [], assets: [], locomotions: [], appearances: [], actions: [], animations: [],
});

const emptyLazyLists = (): Record<Key, number[]> => ({
  transforms: EMPTY_EIDS as number[],
  positions: EMPTY_EIDS as number[],
  velocities: EMPTY_EIDS as number[],
  intents: EMPTY_EIDS as number[],
  chunks: EMPTY_EIDS as number[],
  healths: EMPTY_EIDS as number[],
  staminas: EMPTY_EIDS as number[],
  characterRefs: EMPTY_EIDS as number[],
  bodies: EMPTY_EIDS as number[],
  assets: EMPTY_EIDS as number[],
  locomotions: EMPTY_EIDS as number[],
  appearances: EMPTY_EIDS as number[],
  actions: EMPTY_EIDS as number[],
  animations: EMPTY_EIDS as number[],
});

const pushEid = (l: Record<Key, number[]>, k: Key, eid: number): void => {
  const arr = l[k];
  if (arr === EMPTY_EIDS) {
    l[k] = [eid];
  } else {
    arr.push(eid);
  }
};

const SECTOR_GRID_OFFSET = 512;
const SECTOR_GRID_STRIDE = 1024;
const sectorKeyCache = new Array<string | undefined>(SECTOR_GRID_STRIDE * SECTOR_GRID_STRIDE);
const sectorCoordsCache = new Map<string, readonly [number, number]>();

const keyOf = (sx: number, sz: number): string => {
  const ix = (sx + SECTOR_GRID_OFFSET) | 0;
  const iz = (sz + SECTOR_GRID_OFFSET) | 0;
  if ((ix >>> 0) < SECTOR_GRID_STRIDE && (iz >>> 0) < SECTOR_GRID_STRIDE) {
    const idx = ix * SECTOR_GRID_STRIDE + iz;
    let k = sectorKeyCache[idx];
    if (k === undefined) {
      k = `${sx},${sz}`;
      sectorKeyCache[idx] = k;
      sectorCoordsCache.set(k, [sx, sz]);
    }
    return k;
  }
  const k = `${sx},${sz}`;
  if (!sectorCoordsCache.has(k)) sectorCoordsCache.set(k, [sx, sz]);
  return k;
};

/** The sector an entity lives in now: its Transform's cell, or "g". */
export function homeSector(sim: SimWorld, eid: number): string {
  if (!hasComponent(sim.ecs, C.Transform, eid) || hasComponent(sim.ecs, C.Chunk, eid)) return GLOBAL_SECTOR;
  return keyOf(Math.floor(C.Transform.px[eid] / SECTOR_SIZE), Math.floor(C.Transform.pz[eid] / SECTOR_SIZE));
}

const throwImmutableSet = (): never => {
  throw new TypeError("Cannot mutate canonical interest Set; replace the session reference instead.");
};

const lockedCanonicalSets = new WeakSet<ReadonlySet<string>>();

class CanonicalSectorSet extends Set<string> {
  override add(value: string): this {
    if (lockedCanonicalSets.has(this)) throwImmutableSet();
    return super.add(value);
  }
  override delete(_value: string): boolean {
    if (lockedCanonicalSets.has(this)) return throwImmutableSet();
    return super.delete(_value);
  }
  override clear(): void {
    if (lockedCanonicalSets.has(this)) throwImmutableSet();
    super.clear();
  }
}

/**
 * Create or wrap a Set<string> whose .add(), .delete(), and .clear() methods throw TypeError
 * at runtime. This is a contract guard against accidental mutation of shared canonical sets
 * (such as calling .clear() during resync), not a security boundary against arbitrary reflection.
 */
export function freezeCanonicalSet(s: Iterable<string>): ReadonlySet<string> {
  if (s instanceof CanonicalSectorSet && lockedCanonicalSets.has(s)) return s;
  const c = new CanonicalSectorSet(s);
  lockedCanonicalSets.add(c);
  return c;
}

/**
 * Registry of steady-state DeltaSetEntry[] arrays produced by SectorFrame.steadyDeltaEntries.
 * Contract: for the single-tick lifetime of a SectorFrame / NativeFanout broadcast, the array,
 * its DeltaSetEntry descriptor objects ({ kind, sector, bytes }), and each descriptor's Uint8Array
 * payload (a fresh slice stored in SectorFrame.deltas) are never mutated in place after creation.
 */
export const steadyEntryArrays = new WeakSet<readonly DeltaSetEntry[]>();

/** Maximum number of distinct canonical sector sets retained in a canon map before FIFO eviction. */
export const MAX_CANONICAL_INTEREST_SETS = 4096;

/**
 * The sectors a viewer at (x, z) sees: every sector whose rectangle is within enterM, plus those in
 * `prev` still within leaveM. Always includes "g".
 */
export function interestSectors(x: number, z: number, r: InterestRadii, prev: ReadonlySet<string> | null): Set<string> {
  const out = new Set<string>([GLOBAL_SECTOR]);
  const effLeaveM = Math.max(r.enterM, r.leaveM);
  const reach = Math.ceil(effLeaveM / SECTOR_SIZE);
  const cx = Math.floor(x / SECTOR_SIZE), cz = Math.floor(z / SECTOR_SIZE);
  const enterSq = r.enterM * r.enterM;
  const leaveSq = r.leaveM * r.leaveM;
  const maxSq = Math.max(enterSq, leaveSq);
  for (let sx = cx - reach; sx <= cx + reach; sx++) {
    const dx = Math.max(sx * SECTOR_SIZE - x, 0, x - (sx + 1) * SECTOR_SIZE);
    const dxSq = dx * dx;
    if (dxSq > maxSq) continue;
    for (let sz = cz - reach; sz <= cz + reach; sz++) {
      const dz = Math.max(sz * SECTOR_SIZE - z, 0, z - (sz + 1) * SECTOR_SIZE);
      const dSq = dxSq + dz * dz;
      if (dSq <= enterSq) {
        out.add(keyOf(sx, sz));
      } else if (dSq <= leaveSq && prev !== null) {
        const k = keyOf(sx, sz);
        if (prev.has(k)) out.add(k);
      }
    }
  }
  return out;
}

/**
 * Compute a viewer's interest sectors at (x, z) along with `safeMoveSq`: the squared Euclidean distance
 * (x, z) may move from the evaluation point (x0, z0) while remaining mathematically guaranteed to produce
 * the exact same sector set when re-evaluated against the resulting set.
 *
 * Proof boundary:
 * 1. Candidate domain invariance: `minMargin` is initialized to the Euclidean distance from (x0, z0) to the
 *    boundary of its home cell `(cx, cz)`. Any displacement `||p - p0||_2 < safe` stays strictly inside `(cx, cz)`,
 *    so the enumerated candidate window `[cx - reach .. cx + reach] x [cz - reach .. cz + reach]` is identical,
 *    and every sector outside that window is at distance strictly `> reach * SECTOR_SIZE >= max(enterM, leaveM)`.
 * 2. Hysteresis invariance: for each sector `k` included in the returned set `c`, subsequent evaluations pass `c`
 *    as `prev`, where `k` remains included iff `d(p, k) <= max(enterM, leaveM)` (slack `effLeaveM - d(p0, k)`).
 *    For each sector `k` excluded from `c`, subsequent evaluations pass `c` as `prev`, where `k` remains excluded
 *    iff `d(p, k) > enterM` (slack `d(p0, k) - enterM`). By the triangle inequality `|d(p, k) - d(p0, k)| <= ||p - p0||_2`,
 *    no sector can cross its relevant hysteresis threshold while `||p - p0||_2 < safe`.
 * 3. Canonical ordering, runtime immutability contract & bounded retention: sectors are enumerated in
 *    deterministic canonical order (`GLOBAL_SECTOR` followed by strictly ascending `(sx, sz)` grid coordinates).
 *    Returned sets are guarded via `freezeCanonicalSet` and verified for exact element-by-element iteration
 *    order before reuse; `canon` evicts FIFO once `MAX_CANONICAL_INTEREST_SETS` is reached.
 */
export function interestSectorsCached(
  x: number,
  z: number,
  r: InterestRadii,
  prev: ReadonlySet<string> | null,
  canon?: Map<string, ReadonlySet<string>>,
): { set: ReadonlySet<string>; safeMoveSq: number } {
  const enterM = r.enterM, leaveM = r.leaveM;
  const effLeaveM = Math.max(enterM, leaveM);
  const reach = Math.ceil(effLeaveM / SECTOR_SIZE);
  const cx = Math.floor(x / SECTOR_SIZE), cz = Math.floor(z / SECTOR_SIZE);
  const enterSq = enterM * enterM, leaveSq = leaveM * leaveM;
  let minMargin = Math.min(
    x - cx * SECTOR_SIZE,
    (cx + 1) * SECTOR_SIZE - x,
    z - cz * SECTOR_SIZE,
    (cz + 1) * SECTOR_SIZE - z,
  );
  const keys: string[] = [GLOBAL_SECTOR];
  let sig = GLOBAL_SECTOR;
  for (let sx = cx - reach; sx <= cx + reach; sx++) {
    const dx = Math.max(sx * SECTOR_SIZE - x, 0, x - (sx + 1) * SECTOR_SIZE);
    const dxSq = dx * dx;
    for (let sz = cz - reach; sz <= cz + reach; sz++) {
      const dz = Math.max(sz * SECTOR_SIZE - z, 0, z - (sz + 1) * SECTOR_SIZE);
      const dSq = dxSq + dz * dz;
      const d = Math.sqrt(dSq);
      let inc = false;
      let k = "";
      if (dSq <= enterSq) {
        k = keyOf(sx, sz);
        inc = true;
      } else if (dSq <= leaveSq && prev !== null) {
        k = keyOf(sx, sz);
        if (prev.has(k)) inc = true;
      }
      if (inc) {
        keys.push(k);
        if (canon) sig += "|" + k;
        const m = effLeaveM - d;
        if (m < minMargin) minMargin = m;
      } else {
        const m = d - enterM;
        if (m < minMargin) minMargin = m;
      }
    }
  }
  const safe = Math.max(0, minMargin - 1e-3);
  if (canon) {
    let c = canon.get(sig);
    if (c && c.size === keys.length) {
      let i = 0;
      for (const k of c) {
        if (k !== keys[i++]) {
          c = undefined;
          break;
        }
      }
    } else {
      c = undefined;
    }
    if (!c) {
      if (canon.size >= MAX_CANONICAL_INTEREST_SETS) {
        const oldest = canon.keys().next().value;
        if (oldest !== undefined) canon.delete(oldest);
      }
      c = freezeCanonicalSet(keys);
      canon.set(sig, c);
    }
    return { set: c, safeMoveSq: safe * safe };
  }
  return { set: freezeCanonicalSet(keys), safeMoveSq: safe * safe };
}

/**
 * Distance in metres from (x, z) to the rectangle of a sector key ("sx,sz"). The global sector is
 * always 0: it is never rate limited.
 */
export function sectorDistance(key: string, x: number, z: number): number {
  if (key === GLOBAL_SECTOR) return 0;
  let coords = sectorCoordsCache.get(key);
  if (!coords) {
    const comma = key.indexOf(",");
    coords = [Number(key.slice(0, comma)), Number(key.slice(comma + 1))];
    sectorCoordsCache.set(key, coords);
  }
  const sx = coords[0], sz = coords[1];
  const dx = Math.max(sx * SECTOR_SIZE - x, 0, x - (sx + 1) * SECTOR_SIZE);
  const dz = Math.max(sz * SECTOR_SIZE - z, 0, z - (sz + 1) * SECTOR_SIZE);
  return Math.hypot(dx, dz);
}

/** One tick's per-sector bytes. Build before tracker.commit() and sim.endTick(). */
export class SectorFrame {
  /** The frames of the previous ticks, newest first (IM7 reads their changed rows). */
  prior: readonly SectorFrame[] = [];
  private readonly rateCache = new Map<string, Uint8Array | null>();
  /** Sector -> what it has to say this tick; encoded on first ask, so sectors nobody sees cost nothing. */
  readonly pending = new Map<string, { lists: Record<Key, number[]>; spawned: bigint[]; despawned: bigint[] }>();
  private readonly deltas = new Map<string, Uint8Array>();
  private readonly fulls = new Map<string, Uint8Array>();
  private readonly steadyEntriesCache = new Map<ReadonlySet<string>, readonly DeltaSetEntry[]>();
  private buckets: Map<string, Record<Key, number[]>> | null = null;

  constructor(
    private readonly sim: SimWorld,
    readonly tick: number,
    private readonly chunkSource: ChunkDataSource | null,
  ) {}

  /** A sector's Delta this tick, or undefined when nothing in it changed. */
  delta(sector: string): Uint8Array | undefined {
    let b = this.deltas.get(sector);
    if (!b) {
      const p = this.pending.get(sector);
      if (!p) return undefined;
      b = encodeEidsFromSim(this.sim, this.tick, this.tick - 1, p.lists, p, this.chunkSource);
      this.deltas.set(sector, b);
    }
    return b;
  }

  /**
   * Shared immutable DeltaSetEntry[] for a steady-state session (unchanged canonical interest set, no outerEvery rate limit,
   * no replace). Computed once per unique canonical Set<string> per tick and frozen so callers cannot mutate shared entries.
   */
  steadyDeltaEntries(sectors: ReadonlySet<string>): readonly DeltaSetEntry[] {
    let cached = this.steadyEntriesCache.get(sectors);
    if (!cached) {
      const list: DeltaSetEntry[] = [];
      for (const sector of sectors) {
        const d = this.delta(sector);
        if (d) list.push({ kind: DeltaSetKind.Delta, sector, bytes: d });
      }
      steadyEntryArrays.add(list);
      cached = list;
      this.steadyEntriesCache.set(sectors, cached);
    }
    return cached;
  }

  /**
   * IM7: a sector's delta over the last `window` ticks (this one and the prior frames): the union of
   * their changed rows, read at current values. Rows are absolute, so one send covers every skipped tick.
   * Returns undefined when nothing changed in the window; cached per frame.
   */
  rateDelta(sector: string, window: number): Uint8Array | undefined {
    const cached = this.rateCache.get(sector);
    if (cached !== undefined) return cached ?? undefined;
    const lists = emptyLists();
    const seen = new Map<Key, Set<number>>();
    const spawned = new Set<bigint>(), despawned = new Set<bigint>();
    let any = false;
    for (const f of [this, ...this.prior.slice(0, window - 1)]) {
      const p = f.pending.get(sector);
      if (!p) continue;
      any = true;
      for (const k of RATE_KEYS) {
        let set = seen.get(k);
        if (!set) seen.set(k, (set = new Set()));
        for (const eid of p.lists[k]) if (!set.has(eid)) { set.add(eid); lists[k].push(eid); }
      }
      for (const w of p.spawned) spawned.add(w);
      for (const w of p.despawned) despawned.add(w);
    }
    if (!any) {
      this.rateCache.set(sector, null);
      return undefined;
    }
    // A position row for an entity that also has a full transform row in the window is redundant: the full row is read at current values.
    if (lists.positions.length > 0) {
      const full = seen.get("transforms");
      if (full && full.size > 0) lists.positions = lists.positions.filter((e) => !full.has(e));
    }
    const b = encodeEidsFromSim(this.sim, this.tick, this.tick - window, lists, { spawned: [...spawned], despawned: [...despawned] }, this.chunkSource);
    this.rateCache.set(sector, b);
    return b;
  }

  /** Every sector something lives in now, plus "g" (the `all` mode's interest set). */
  occupied(): Set<string> {
    this.buckets ??= bucketAll(this.sim);
    return new Set([GLOBAL_SECTOR, ...this.buckets.keys()]);
  }

  /** A sector's full state now (every entity homed there, all rows), encoded once per tick. */
  full(sector: string): Uint8Array {
    let b = this.fulls.get(sector);
    if (!b) {
      this.buckets ??= bucketAll(this.sim);
      const lists = this.buckets.get(sector) ?? emptyLists();
      b = encodeEidsFromSim(this.sim, this.tick, 0, lists, { spawned: [], despawned: [] }, this.chunkSource);
      this.fulls.set(sector, b);
    }
    return b;
  }
}

function bucketAll(sim: SimWorld): Map<string, Record<Key, number[]>> {
  const out = new Map<string, Record<Key, number[]>>();
  const bound = sim.maxSlotSeen + 1;
  const memo = new Array<Record<Key, number[]> | undefined>(bound);
  const full = fullEidLists(sim);
  for (const [k] of KEYS) {
    const eids = full[k];
    for (let i = 0; i < eids.length; i++) {
      const eid = eids[i];
      let l = memo[eid];
      if (l === undefined) {
        const s = homeSector(sim, eid);
        l = out.get(s);
        if (!l) out.set(s, (l = emptyLazyLists()));
        memo[eid] = l;
      }
      pushEid(l, k, eid);
    }
  }
  return out;
}

/** Keeps every entity's home sector across ticks and cuts each tick into sector deltas. */
/** Frames kept for IM7's windows (the widest rate period it can read is this many ticks). */
export const RATE_HISTORY = 8;

export class SectorIndex {
  /** Slot-indexed home sector + wire id as of the last frame (eliminates per-entity Map<bigint, string> hashing). */
  private homeSlotWid = new BigUint64Array(1024);
  private homeSlotSec: Array<string | undefined> = new Array(1024);
  private memoTag = new Uint32Array(1024);
  private memoVal: Array<string | undefined> = new Array(1024);
  private memoBucket: Array<Record<Key, number[]> | undefined> = new Array(1024);
  private movedTag = new Uint32Array(1024);
  private frameSeq = 0;
  private recent: SectorFrame[] = [];
  private seeded = false;

  private ensureCapacity(bound: number): void {
    if (this.homeSlotWid.length < bound) {
      const n = Math.max(bound * 2, 1024);
      const w = new BigUint64Array(n);
      w.set(this.homeSlotWid);
      this.homeSlotWid = w;
      this.homeSlotSec.length = n;
      this.memoTag = new Uint32Array(n);
      this.memoVal.length = n;
      this.memoBucket.length = n;
      this.movedTag = new Uint32Array(n);
    }
  }

  /** Fast O(1) lookup of an entity's current home sector using the slot table maintained by frame(). */
  sectorOfEntity(sim: SimWorld, eid: number, wid: bigint): string {
    if (eid >= 0 && eid < this.homeSlotWid.length && this.homeSlotWid[eid] === wid) {
      const s = this.homeSlotSec[eid];
      if (s !== undefined) return s;
    }
    return homeSector(sim, eid);
  }

  /** This tick's sector deltas. Read-only w.r.t. the tracker (the caller commits after). */
  frame(sim: SimWorld, tick: number, tracker: DeltaTracker, chunkSource: ChunkDataSource | null): SectorFrame {
    const f = new SectorFrame(sim, tick, chunkSource);
    // Only the newest frame reads `prior` (rateDelta). Clear the old newest's, or each frame keeps
    // its predecessor's list alive and every frame since boot stays reachable.
    if (this.recent[0]) this.recent[0].prior = [];
    f.prior = this.recent;
    this.recent = [f, ...this.recent].slice(0, RATE_HISTORY);
    const bound = sim.maxSlotSeen + 1;
    this.ensureCapacity(bound);
    const homeWid = this.homeSlotWid;
    const homeSec = this.homeSlotSec;
    if (!this.seeded) {
      this.seeded = true;
      const t = fullEidLists(sim).transforms;
      for (let i = 0; i < t.length; i++) {
        const eid = t[i];
        homeWid[eid] = sim.wireId(eid);
        homeSec[eid] = homeSector(sim, eid);
      }
    }
    const spawnedSlots = spawnedSlotsOf(sim);
    const hasSpawned = spawnedSlots.size !== 0;
    const diff: DiffResult = tracker.diff(sim, spawnedSlots);
    let seq = (this.frameSeq + 1) >>> 0;
    if (seq === 0) {
      seq = 1;
      this.memoTag.fill(0);
      this.movedTag.fill(0);
    }
    this.frameSeq = seq;
    const memoTag = this.memoTag;
    const memoVal = this.memoVal;
    const memoBucket = this.memoBucket;
    const movedTag = this.movedTag;
    const lists = new Map<string, Record<Key, number[]>>();
    const listsOf = (s: string): Record<Key, number[]> => {
      let l = lists.get(s);
      if (!l) lists.set(s, (l = emptyLazyLists()));
      return l;
    };
    const sectorOf = (eid: number): string => {
      if (memoTag[eid] === seq) return memoVal[eid]!;
      const s = homeSector(sim, eid);
      memoTag[eid] = seq;
      memoVal[eid] = s;
      memoBucket[eid] = undefined;
      return s;
    };
    const bucketOf = (eid: number): Record<Key, number[]> => {
      if (memoTag[eid] === seq) {
        let b = memoBucket[eid];
        if (b === undefined) {
          b = listsOf(memoVal[eid]!);
          memoBucket[eid] = b;
        }
        return b;
      }
      const s = homeSector(sim, eid);
      memoTag[eid] = seq;
      memoVal[eid] = s;
      const b = listsOf(s);
      memoBucket[eid] = b;
      return b;
    };
    const outOf = new Map<string, bigint[]>();
    const movedIn = new Map<string, number[]>();
    let anyMoved = false;
    // Sector moves: only entities whose Transform changed can have moved.
    const changedTransforms = diff.transforms;
    for (let i = 0; i < changedTransforms.length; i++) {
      const eid = changedTransforms[i];
      const wid = sim.wireId(eid);
      const now = sectorOf(eid);
      const prevSec = homeSec[eid];
      const was = prevSec !== undefined && homeWid[eid] === wid ? prevSec : undefined;
      homeWid[eid] = wid;
      homeSec[eid] = now;
      if (was === undefined || was === now || (hasSpawned && spawnedSlots.has(eid))) continue;
      let o = outOf.get(was);
      if (!o) outOf.set(was, (o = []));
      o.push(wid);
      let m = movedIn.get(now);
      if (!m) movedIn.set(now, (m = []));
      m.push(eid);
      movedTag[eid] = seq;
      anyMoved = true;
    }
    const rawDespawned = sim.despawnedWireIds();
    const despawned = rawDespawned.length === 0 ? (EMPTY_BIGINT_LIST as bigint[]) : [...rawDespawned];
    for (let i = 0; i < despawned.length; i++) {
      const wid = despawned[i];
      const slot = Number(wid & 0xffffffffn);
      if (slot < homeWid.length && homeWid[slot] === wid) {
        homeWid[slot] = 0n;
        homeSec[slot] = undefined;
      }
    }
    // Changed rows, by home sector; an entity that moved in gets all its rows instead.
    const hasPosOnly = tracker.hasPositionOnly();
    for (let ki = 0; ki < KEYS.length; ki++) {
      const k = KEYS[ki][0];
      const changed = diff[k as "transforms"];
      if (changed.length === 0) continue;
      if (k === "transforms" && hasPosOnly) {
        for (let i = 0; i < changed.length; i++) {
          const eid = changed[i];
          if (anyMoved && movedTag[eid] === seq) continue;
          const l = bucketOf(eid);
          if (tracker.isPositionOnly(eid)) pushEid(l, "positions", eid);
          else pushEid(l, "transforms", eid);
        }
      } else {
        for (let i = 0; i < changed.length; i++) {
          const eid = changed[i];
          if (anyMoved && movedTag[eid] === seq) continue;
          pushEid(bucketOf(eid), k, eid);
        }
      }
    }
    if (anyMoved) {
      for (const [s, eids] of movedIn) {
        const l = listsOf(s);
        for (let i = 0; i < eids.length; i++) {
          const eid = eids[i];
          for (let ki = 0; ki < KEYS.length; ki++) {
            const [k, comp] = KEYS[ki];
            if (hasComponent(sim.ecs, comp, eid)) pushEid(l, k, eid);
          }
        }
      }
    }
    const rawSpawned = sim.spawnedWireIds();
    const spawnedWids = rawSpawned.length === 0 ? (EMPTY_BIGINT_LIST as bigint[]) : [...rawSpawned];
    const emptyLazy = emptyLazyLists();
    for (const [s, l] of lists) {
      const g = s === GLOBAL_SECTOR;
      f.pending.set(s, {
        lists: l,
        spawned: g ? spawnedWids : (EMPTY_BIGINT_LIST as bigint[]),
        despawned: g ? despawned : (outOf.get(s) ?? (EMPTY_BIGINT_LIST as bigint[])),
      });
    }
    for (const [s, out] of outOf) {
      if (lists.has(s)) continue;
      const g = s === GLOBAL_SECTOR;
      f.pending.set(s, {
        lists: emptyLazy,
        spawned: g ? spawnedWids : (EMPTY_BIGINT_LIST as bigint[]),
        despawned: g ? despawned : out,
      });
    }
    if (!f.pending.has(GLOBAL_SECTOR)) {
      f.pending.set(GLOBAL_SECTOR, {
        lists: emptyLazy,
        spawned: spawnedWids,
        despawned,
      });
    }
    return f;
  }
}

/** The sector name of a session's pinned entry. */
export const PINNED_SECTOR = "pin";

/**
 * A session's pinned entry (IM5): entities it always sees, outside its interest sectors. Newly pinned
 * ones carry all their rows; the rest their Transform and Health each tick (a party and a few foes,
 * so the per-session encode stays small); `left` are pins dropped while out of view.
 */
export function encodePinned(sim: SimWorld, tick: number, fresh: number[], kept: number[], left: bigint[]): Uint8Array {
  const l = emptyLists();
  for (const eid of fresh) for (const [k, comp] of KEYS) if (hasComponent(sim.ecs, comp, eid)) l[k].push(eid);
  for (const eid of kept) {
    if (hasComponent(sim.ecs, C.Transform, eid)) l.transforms.push(eid);
    if (hasComponent(sim.ecs, C.Health, eid)) l.healths.push(eid);
  }
  return encodeEidsFromSim(sim, tick, tick - 1, l, { spawned: [], despawned: left });
}

/** A region's ground in world units (IM8): [x0, x1) x [z0, z1). */
export interface RegionRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Distance from (x, z) to a region's rectangle (0 inside). */
export function rectDistance(r: RegionRect, x: number, z: number): number {
  return Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.z0 - z, 0, z - r.z1));
}

/** The point of a rectangle nearest (x, z): an observer's anchor stays in its home region. */
export function clampInto(r: RegionRect, x: number, z: number): { x: number; z: number } {
  return { x: Math.min(Math.max(x, r.x0), r.x1), z: Math.min(Math.max(z, r.z0), r.z1) };
}

/** A ticket is the right HMAC (constant time). */
export function ticketOk(key: string, region: string, from: string, account: string, exp: number, ticket: string): boolean {
  const want = Buffer.from(borderTicket(key, region, from, account, exp), "hex");
  const got = Buffer.from(ticket, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The border ticket (IM8): HMAC-SHA256(key, "border|region|from|account|exp"), hex. */
export function borderTicket(key: string, region: string, from: string, account: string, exp: number): string {
  return createHmac("sha256", key).update(`border|${region}|${from}|${account}|${exp}`).digest("hex");
}
