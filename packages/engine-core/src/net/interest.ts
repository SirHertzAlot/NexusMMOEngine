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
import { hasComponent } from "bitecs";
import { GLOBAL_SECTOR } from "@mmo-engine/protocol";
import * as C from "../components.js";
import { encodeEidsFromSim, fullEidLists, spawnedSlotsOf, type DeltaTracker, type DiffResult, type SoAEidLists } from "../snapshot.js";
import type { SimWorld } from "../world.js";
import type { ChunkDataSource } from "../procgen/chunk-source.js";
import { SECTOR_SIZE } from "./sector.js";

export interface InterestRadii {
  enterM: number;
  leaveM: number;
}

export const DEFAULT_INTEREST: InterestRadii = { enterM: 96, leaveM: 128 };

type Key = keyof SoAEidLists;
const KEYS: Array<[Key, object]> = [
  ["transforms", C.Transform], ["velocities", C.Velocity], ["intents", C.PlayerIntent], ["chunks", C.Chunk],
  ["healths", C.Health], ["staminas", C.Stamina], ["characterRefs", C.CharacterRef], ["bodies", C.BodyConfig],
  ["assets", C.AssetRef], ["locomotions", C.Locomotion], ["appearances", C.Appearance], ["actions", C.Action],
  ["animations", C.Animation],
];

const emptyLists = (): Record<Key, number[]> => ({
  transforms: [], velocities: [], intents: [], chunks: [], healths: [], staminas: [], characterRefs: [],
  bodies: [], assets: [], locomotions: [], appearances: [], actions: [], animations: [],
});

const keyOf = (sx: number, sz: number): string => `${sx},${sz}`;

/** The sector an entity lives in now: its Transform's cell, or "g". */
export function homeSector(sim: SimWorld, eid: number): string {
  if (!hasComponent(sim.ecs, C.Transform, eid) || hasComponent(sim.ecs, C.Chunk, eid)) return GLOBAL_SECTOR;
  return keyOf(Math.floor(C.Transform.px[eid] / SECTOR_SIZE), Math.floor(C.Transform.pz[eid] / SECTOR_SIZE));
}

/**
 * The sectors a viewer at (x, z) sees: every sector whose rectangle is within enterM, plus those in
 * `prev` still within leaveM. Always includes "g".
 */
export function interestSectors(x: number, z: number, r: InterestRadii, prev: ReadonlySet<string> | null): Set<string> {
  const out = new Set<string>([GLOBAL_SECTOR]);
  const reach = Math.ceil(r.leaveM / SECTOR_SIZE);
  const cx = Math.floor(x / SECTOR_SIZE), cz = Math.floor(z / SECTOR_SIZE);
  for (let sx = cx - reach; sx <= cx + reach; sx++) {
    const dx = Math.max(sx * SECTOR_SIZE - x, 0, x - (sx + 1) * SECTOR_SIZE);
    for (let sz = cz - reach; sz <= cz + reach; sz++) {
      const dz = Math.max(sz * SECTOR_SIZE - z, 0, z - (sz + 1) * SECTOR_SIZE);
      const d = Math.hypot(dx, dz);
      const k = keyOf(sx, sz);
      if (d <= r.enterM || (d <= r.leaveM && prev?.has(k))) out.add(k);
    }
  }
  return out;
}

/** One tick's per-sector bytes. Build before tracker.commit() and sim.endTick(). */
export class SectorFrame {
  /** Sector -> what it has to say this tick; encoded on first ask, so sectors nobody sees cost nothing. */
  readonly pending = new Map<string, { lists: Record<Key, number[]>; spawned: bigint[]; despawned: bigint[] }>();
  private readonly deltas = new Map<string, Uint8Array>();
  private readonly fulls = new Map<string, Uint8Array>();
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
  const memo = new Map<number, string>();
  const full = fullEidLists(sim);
  for (const [k] of KEYS) {
    const eids = full[k];
    for (let i = 0; i < eids.length; i++) {
      const eid = eids[i];
      let s = memo.get(eid);
      if (s === undefined) memo.set(eid, (s = homeSector(sim, eid)));
      let l = out.get(s);
      if (!l) out.set(s, (l = emptyLists()));
      l[k].push(eid);
    }
  }
  return out;
}

/** Keeps every entity's home sector across ticks and cuts each tick into sector deltas. */
export class SectorIndex {
  /** wire id -> home sector, as of the last frame. */
  private readonly home = new Map<bigint, string>();
  private seeded = false;

  /** This tick's sector deltas. Read-only w.r.t. the tracker (the caller commits after). */
  frame(sim: SimWorld, tick: number, tracker: DeltaTracker, chunkSource: ChunkDataSource | null): SectorFrame {
    const f = new SectorFrame(sim, tick, chunkSource);
    if (!this.seeded) {
      this.seeded = true;
      const t = fullEidLists(sim).transforms;
      for (let i = 0; i < t.length; i++) this.home.set(sim.wireId(t[i]), homeSector(sim, t[i]));
    }
    const diff: DiffResult = tracker.diff(sim, spawnedSlotsOf(sim));
    const memo = new Map<number, string>();
    const sectorOf = (eid: number): string => {
      let s = memo.get(eid);
      if (s === undefined) memo.set(eid, (s = homeSector(sim, eid)));
      return s;
    };
    const lists = new Map<string, Record<Key, number[]>>();
    const listsOf = (s: string): Record<Key, number[]> => {
      let l = lists.get(s);
      if (!l) lists.set(s, (l = emptyLists()));
      return l;
    };
    const outOf = new Map<string, bigint[]>();
    const movedIn = new Map<string, number[]>();
    const spawned = new Set(sim.spawnedWireIds());
    // Sector moves: only entities whose Transform changed can have moved.
    for (const eid of diff.transforms) {
      const wid = sim.wireId(eid);
      const now = sectorOf(eid);
      const was = this.home.get(wid);
      this.home.set(wid, now);
      if (was === undefined || was === now || spawned.has(wid)) continue;
      let o = outOf.get(was);
      if (!o) outOf.set(was, (o = []));
      o.push(wid);
      let m = movedIn.get(now);
      if (!m) movedIn.set(now, (m = []));
      m.push(eid);
    }
    const despawned = [...sim.despawnedWireIds()];
    for (const wid of despawned) this.home.delete(wid);
    // Changed rows, by home sector; an entity that moved in gets all its rows instead.
    const moved = new Set<number>();
    for (const m of movedIn.values()) for (const eid of m) moved.add(eid);
    for (const [k] of KEYS) {
      const changed = diff[k as keyof DiffResult];
      for (let i = 0; i < changed.length; i++) {
        const eid = changed[i];
        if (!moved.has(eid)) listsOf(sectorOf(eid))[k].push(eid);
      }
    }
    for (const [s, eids] of movedIn) {
      const l = listsOf(s);
      for (const eid of eids) for (const [k, comp] of KEYS) if (hasComponent(sim.ecs, comp, eid)) l[k].push(eid);
    }
    for (const s of new Set<string>([...lists.keys(), ...outOf.keys(), GLOBAL_SECTOR])) {
      const g = s === GLOBAL_SECTOR;
      f.pending.set(s, {
        lists: lists.get(s) ?? emptyLists(),
        spawned: g ? [...spawned] : [],
        despawned: g ? despawned : (outOf.get(s) ?? []),
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
