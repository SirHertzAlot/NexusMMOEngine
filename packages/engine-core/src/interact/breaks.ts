/**
 * BreakSystem (IX4, IX5): props that break. An archetype with `breakable` spawns with
 * Health and the Breakable tag (scatter-spawn); a scene node registers with `register`.
 * Combat already hurts anything with Health and DeathSystem skips the tag, so at zero it
 * is this system's turn:
 *
 * - "remove": the entity goes.
 * - "variant": it stays, broken: its AssetRef variant becomes BROKEN_VARIANT (the
 *   client draws it lowered), its collider and health go, and it is no longer breakable.
 * - "debris": it goes and the `debris` archetype stands in its place.
 *
 * In every case the archetype's `loot` table is rolled at the spot for whoever dealt the
 * last blow. With `respawnS` the prop comes back that many seconds later (a removed one
 * is spawned again from what it was, a broken one is whole again); without it, it stays
 * broken, and with `repair` (a building: `minStrength` keeps weak players from hurting it) it can be mended: E on the ruin
 * spends pouch materials over a cast and makes it whole. A keyed prop (a scene node: `places/P0001`) is saved to the places store when
 * it breaks, and `register` applies the record after a restart, so a break survives it.
 */

import { addComponent, defineQuery, hasComponent, removeComponent } from "bitecs";
import { fnv1a32 } from "@mmo-engine/scatter";
import type { Breakable as BreakableDef, SpawnTable } from "@mmo-engine/scatter";
import { BROKEN_VARIANT } from "@mmo-engine/protocol";
import { AssetRef, BodyConfig, Breakable, Health, Transform, Velocity } from "../components.js";
import { INVALID_POOL_HANDLE, RespawnKind, SlotState, type SpawnPoolSoA } from "../pools/spawn-pool-soa.js";
import type { SimWorld } from "../world.js";
import type { SimSystem } from "../systems.js";
import type { SystemAccess } from "../system-access.js";
import type { PlacesStore } from "./places-store.js";
import type { ChestView } from "@mmo-engine/protocol";

/** What a break tells the host: where, what it was, what it breaks into, and who dealt the last blow. */
export interface BreakEvent {
  eid: number;
  x: number;
  z: number;
  /** The archetype's loot table, if it has one. */
  loot?: string;
  killer?: number;
}

export interface BreakSystemOptions {
  /** The entity that dealt `e`'s last blow, if known. */
  killerOf?: (e: number) => number | undefined;
  /** A prop broke: roll its loot, count it, tell the run. Called before the entity changes. Not called when a record is re-applied on boot. */
  onBreak?: (sim: SimWorld, ev: BreakEvent) => void;
  /** Stand the `debris` archetype where a prop was; returns the debris entity so a respawn can clear it. */
  spawnDebris?: (sim: SimWorld, debris: string, x: number, y: number, z: number, yaw: number) => number | void;
  /** Where breaks of keyed props are kept (IX5). */
  store?: PlacesStore;
  /** The pouch materials a repair spends (IX6). */
  materials?: { count(holder: number, material: string): number; spend(holder: number, material: string, n: number): boolean };
  /** How close to a ruin's edge a mender must stand, metres. Default 3. */
  repairReachM?: number;
  /** Optional SAB SpawnPoolSoA mirroring timed breakable prop respawns. */
  pool?: SpawnPoolSoA;
  now?: () => number;
}

/** The breakable archetypes of spawn tables, by the hash of the asset id an entity's AssetRef carries. */
export function breakDefsOf(...tables: Array<SpawnTable | undefined>): Map<number, BreakableDef> {
  const out = new Map<number, BreakableDef>();
  for (const t of tables) {
    if (!t) continue;
    for (const [id, a] of Object.entries(t.archetypes)) {
      if (!a.breakable) continue;
      out.set(fnv1a32(id) >>> 0, a.breakable);
      out.set(fnv1a32(a.asset) >>> 0, a.breakable);
    }
  }
  return out;
}

const TF = ["px", "py", "pz", "qx", "qy", "qz", "qw", "sx", "sy", "sz"] as const;
const BODY = ["shapeKind", "halfX", "halfY", "halfZ", "radius", "mass", "motionType", "layer", "friction", "restitution"] as const;

/** Everything needed to put a prop back as it was. */
interface Snap {
  tf: number[];
  assetHash: number;
  variant: number;
  body: number[] | null;
  hp: number;
}

interface Ruin {
  key: string | null;
  def: BreakableDef;
  snap: Snap;
  poolHandle: number;
}

export type RepairCheck = { ok: true; castSeconds: number; spell: string } | { ok: false; error: string };
export type RepairResult = { ok: true } | { ok: false; error: string };

interface Pending {
  key: string | null;
  def: BreakableDef;
  snap: Snap;
  respawnAt: number;
  /** "variant": the broken entity itself. */
  eid: number | null;
  /** "debris": the debris that stands there meanwhile. */
  debris: number | null;
  poolHandle: number;
}

export class BreakSystem implements SimSystem {
  readonly name = "breaks";
  readonly access: SystemAccess = {
    system: "breaks",
    reads: [
      "BodyConfig",
      "Breakable",
      { component: "AssetRef", fields: ["assetHash", "variant"] },
      { component: "Health", fields: ["current", "max"] },
      { component: "Transform", fields: ["px", "py", "pz", "qw", "qy"] },
    ],
    writes: [
      "BodyConfig",
      "Breakable",
      "Transform",
      { component: "AssetRef", fields: ["assetHash", "variant"] },
      { component: "Health", fields: ["current", "max"] },
      { component: "Velocity", fields: ["ax", "ay", "az", "lx", "ly", "lz"] },
    ],
  };
  private readonly bodies = defineQuery([Transform, Health, Breakable]);
  private readonly keys = new Map<number, string>();
  private readonly eidDefs = new Map<number, BreakableDef>();
  private readonly customStages = new Map<string, readonly number[]>();
  private readonly eidToPoolHandle = new Map<number, number>();
  private readonly slotToPending = new Map<number, Pending>();
  private readonly pool?: SpawnPoolSoA;
  private readonly readyScratch: Int32Array;
  private pending: Pending[] = [];
  /** Buildings that stand broken and can be mended, by entity. */
  private readonly ruins = new Map<number, Ruin>();
  private changed = new Set<number>();
  private readonly now: () => number;
  /** Props broken so far (a run's or the world's tally). */
  broken = 0;

  constructor(
    private readonly defs: ReadonlyMap<number, BreakableDef>,
    private readonly opts: BreakSystemOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.pool = opts.pool;
    this.readyScratch = opts.pool
      ? new Int32Array(Math.max(64, opts.pool.capacity))
      : new Int32Array(0);
  }

  /** Packed `SpawnPoolSoA` slot handle for breakable prop `eid`, or `0` (`INVALID_POOL_HANDLE`) if absent. */
  poolSlotOf(eid: number): number {
    return this.eidToPoolHandle.get(eid) ?? INVALID_POOL_HANDLE;
  }

  /**
   * Make a spawned entity (a scene node) breakable under `key`, with `def`, and apply what the places
   * store remembers of it: broken and not yet back, it breaks again now, silently; back by now, it is whole.
   */
  register(sim: SimWorld, eid: number, key: string, def: BreakableDef): void {
    if (!hasComponent(sim.ecs, Health, eid)) addComponent(sim.ecs, Health, eid);
    Health.current[eid] = Health.max[eid] = def.health;
    addComponent(sim.ecs, Breakable, eid);
    this.keys.set(eid, key);
    this.eidDefs.set(eid, def);
    if (def.stages && def.stages.length > 0 && hasComponent(sim.ecs, AssetRef, eid)) {
      this.customStages.set(`${AssetRef.assetHash[eid]! >>> 0}:${def.health}`, def.stages);
    }

    const rec = this.opts.store?.load("break", key);
    if (this.pool) {
      let handle = this.pool.findByKey(key);
      const delayMs = def.respawnS !== null ? Math.max(0, def.respawnS * 1000) : 0;
      if (handle === INVALID_POOL_HANDLE) {
        const px = Transform.px[eid];
        const py = Transform.py[eid];
        const pz = Transform.pz[eid];
        const assetHash = hasComponent(sim.ecs, AssetRef, eid) ? AssetRef.assetHash[eid]! >>> 0 : 0;
        const radius = hasComponent(sim.ecs, BodyConfig, eid)
          ? Math.max(0, BodyConfig.radius[eid]!, BodyConfig.halfX[eid]!, BodyConfig.halfZ[eid]!)
          : 0;
        handle = this.pool.allocateSlot({
          key,
          kind: RespawnKind.BreakableProp,
          state: SlotState.Active,
          modelHash: assetHash,
          liveEid: eid,
          stock: 1,
          maxStock: 1,
          homeX: Number.isFinite(px) ? px! : 0,
          homeY: Number.isFinite(py) ? py! : 0,
          homeZ: Number.isFinite(pz) ? pz! : 0,
          footprintRadiusM: Number.isFinite(radius) ? radius : 0,
          respawnDelayMs: delayMs,
        });
        if (handle !== INVALID_POOL_HANDLE) this.eidToPoolHandle.set(eid, handle);
      } else {
        this.eidToPoolHandle.set(eid, handle);
        const idx = handle & 0xffff;
        if (!rec) {
          const st = this.pool.state[idx]!;
          if (st === SlotState.CooldownRespawn && Number.isFinite(this.pool.respawnAtMs[idx]!)) {
            const now = this.now();
            if (now >= this.pool.respawnAtMs[idx]!) {
              this.pool.markActive(handle, eid, 1);
            } else {
              const rAt = this.pool.respawnAtMs[idx]!;
              const dMs = this.pool.respawnDelayMs[idx]!;
              this.breakIt(sim, eid, def, { at: rAt - dMs, respawnAt: rAt });
              return;
            }
          } else if (st === SlotState.Exhausted) {
            this.breakIt(sim, eid, def, { at: this.now(), respawnAt: null });
            return;
          } else {
            this.pool.markActive(handle, eid, 1);
          }
        }
        if (this.pool.respawnDelayMs[idx]! === 0 && delayMs > 0) {
          this.pool.respawnDelayMs[idx] = delayMs;
        }
      }
    }

    if (!rec) return;
    if (rec.respawnAt !== null && this.now() >= rec.respawnAt) {
      this.opts.store!.clear("break", key); // it came back while the server was down
      const handle = this.eidToPoolHandle.get(eid) ?? INVALID_POOL_HANDLE;
      if (this.pool && handle !== INVALID_POOL_HANDLE && this.pool.isValidHandle(handle)) {
        this.pool.markActive(handle, eid, 1);
      }
      return;
    }
    this.breakIt(sim, eid, def, { at: rec.at, respawnAt: rec.respawnAt });
  }

  private recovered = false;

  /** Once after a boot: scatter props that broke before the restart are put back on their timers (their def is found by asset). */
  private recover(sim: SimWorld): void {
    this.recovered = true;
    for (const rec of this.opts.store?.all?.() ?? []) {
      if (rec.kind !== "break" || !rec.state.startsWith("scatter:") || rec.respawnAt === null) continue;
      let snap: Snap;
      try {
        snap = JSON.parse(rec.state.slice("scatter:".length)) as Snap;
      } catch {
        this.opts.store!.clear("break", rec.key);
        continue;
      }
      const def = this.defs.get(snap.assetHash >>> 0);
      if (!def) continue;
      let poolHandle = INVALID_POOL_HANDLE;
      if (this.pool) {
        const found = this.pool.findByKey(rec.key);
        const now = this.now();
        if (found !== INVALID_POOL_HANDLE) {
          poolHandle = found;
          this.pool.scheduleRespawn(poolHandle, now, Math.max(0, rec.respawnAt - now));
        } else {
          poolHandle = this.pool.allocateSlot({
            key: rec.key,
            kind: RespawnKind.BreakableProp,
            state: SlotState.CooldownRespawn,
            modelHash: snap.assetHash >>> 0,
            liveEid: -1,
            stock: 0,
            maxStock: 1,
            homeX: Number.isFinite(snap.tf[0]) ? snap.tf[0]! : 0,
            homeY: Number.isFinite(snap.tf[1]) ? snap.tf[1]! : 0,
            homeZ: Number.isFinite(snap.tf[2]) ? snap.tf[2]! : 0,
            respawnDelayMs: def.respawnS !== null ? Math.max(0, def.respawnS * 1000) : 0,
            respawnAtMs: rec.respawnAt,
          });
        }
      }
      const item: Pending = {
        key: rec.key,
        def,
        snap,
        respawnAt: rec.respawnAt,
        eid: null,
        debris: null,
        poolHandle,
      };
      if (this.pool && poolHandle !== INVALID_POOL_HANDLE) {
        this.slotToPending.set(poolHandle & 0xffff, item);
      } else {
        this.pending.push(item);
      }
    }
  }

  step(sim: SimWorld): void {
    if (!this.recovered) this.recover(sim);
    this.respawns(sim);
    const bodyIds = this.bodies(sim.ecs);
    for (let i = 0; i < bodyIds.length; i++) {
      const eid = bodyIds[i]!;
      if (Health.current[eid]! > 0) continue;
      const def = this.eidDefs.get(eid) ?? this.defs.get(AssetRef.assetHash[eid]! >>> 0);
      if (!def) {
        removeComponent(sim.ecs, Breakable, eid); // no data for it: leave it be
        continue;
      }
      this.breakIt(sim, eid, def);
    }
  }

  /** `again`: a record being re-applied on boot (no loot, no event, the recorded times). */
  private breakIt(sim: SimWorld, eid: number, def: BreakableDef, again?: { at: number; respawnAt: number | null }): void {
    const x = Transform.px[eid]!;
    const y = Transform.py[eid]!;
    const z = Transform.pz[eid]!;
    const key = this.keys.get(eid) ?? null;
    let poolHandle = this.eidToPoolHandle.get(eid) ?? INVALID_POOL_HANDLE;
    this.eidToPoolHandle.delete(eid);
    const at = again?.at ?? this.now();
    const respawnAt = again ? again.respawnAt : def.respawnS !== null ? at + def.respawnS * 1000 : null;
    this.broken++;
    if (!again) this.opts.onBreak?.(sim, { eid, x, z, ...(def.loot !== undefined ? { loot: def.loot } : {}), killer: this.opts.killerOf?.(eid) });
    if (key !== null) this.opts.store?.save({ kind: "break", key, state: "broken", at, respawnAt });
    const snap = respawnAt !== null || def.repair ? capture(sim, eid) : null;
    // A world scatter prop has no scene key: it is found again after a restart by what it was and where it stood.
    const scatterKey = key === null && snap && respawnAt !== null && def.into !== "variant" ? `scatter/${snap.assetHash}/${x.toFixed(1)},${z.toFixed(1)}` : null;
    if (scatterKey !== null && !again) this.opts.store?.save({ kind: "break", key: scatterKey, state: `scatter:${JSON.stringify(snap)}`, at, respawnAt });

    if (this.pool) {
      const pKey = key ?? scatterKey ?? (respawnAt !== null && snap ? `scatter/${snap.assetHash}/${x.toFixed(1)},${z.toFixed(1)}` : null);
      if (poolHandle === INVALID_POOL_HANDLE && pKey !== null) {
        const existing = this.pool.findByKey(pKey);
        if (existing !== INVALID_POOL_HANDLE) {
          poolHandle = existing;
        } else if (respawnAt !== null) {
          poolHandle = this.pool.allocateSlot({
            key: pKey,
            kind: RespawnKind.BreakableProp,
            state: SlotState.Active,
            modelHash: snap?.assetHash ? snap.assetHash >>> 0 : 0,
            liveEid: eid,
            stock: 1,
            maxStock: 1,
            homeX: Number.isFinite(x) ? x : 0,
            homeY: Number.isFinite(y) ? y : 0,
            homeZ: Number.isFinite(z) ? z : 0,
            respawnDelayMs: def.respawnS !== null ? Math.max(0, def.respawnS * 1000) : 0,
          });
        }
      }
      if (poolHandle !== INVALID_POOL_HANDLE && this.pool.isValidHandle(poolHandle)) {
        const idx = poolHandle & 0xffff;
        if (respawnAt !== null) {
          this.pool.stock[idx] = 0;
          this.pool.scheduleRespawn(poolHandle, at, Math.max(0, respawnAt - at));
        } else {
          this.pool.stock[idx] = 0;
          this.pool.state[idx] = SlotState.Exhausted;
          this.pool.respawnAtMs[idx] = Number.NaN;
          this.pool.liveEid[idx] = -1;
        }
      }
    }

    let debris: number | null = null;
    this.keys.delete(eid);
    this.eidDefs.delete(eid);
    if (def.into === "variant") {
      AssetRef.variant[eid] = BROKEN_VARIANT;
      removeComponent(sim.ecs, BodyConfig, eid);
      removeComponent(sim.ecs, Health, eid);
      removeComponent(sim.ecs, Breakable, eid);
    } else {
      sim.despawn(eid);
      if (def.into === "debris" && def.debris) {
        const made = this.opts.spawnDebris?.(sim, def.debris, x, y, z, 2 * Math.atan2(Transform.qy[eid]!, Transform.qw[eid]!));
        debris = typeof made === "number" ? made : null;
      }
    }
    if (snap && def.repair && def.into === "variant") {
      this.ruins.set(eid, { key, def, snap, poolHandle });
      this.changed.add(eid);
    }
    if (snap && respawnAt !== null) {
      const pendingItem: Pending = {
        key: key ?? scatterKey,
        def,
        snap,
        respawnAt,
        eid: def.into === "variant" ? eid : null,
        debris,
        poolHandle,
      };
      if (this.pool && poolHandle !== INVALID_POOL_HANDLE && this.pool.isValidHandle(poolHandle)) {
        this.slotToPending.set(poolHandle & 0xffff, pendingItem);
      } else {
        this.pending.push(pendingItem);
      }
    }
  }

  /** Whether a blow from `attacker` can hurt `target`: a building holds out against anyone below its `minStrength` (bodies with no stats pass). */
  canHit(sim: SimWorld, attacker: number, target: number): boolean {
    const need = this.eidDefs.get(target)?.minStrength;
    if (!need) return true;
    const str = sim.stats.get(attacker, "strength");
    return str === undefined || str >= need;
  }

  /** What a blow of `kind` does to `target`, as a multiple: its `damageMultipliers` entry (1 when it has none, or is not breakable). */
  kindScale(target: number, kind: string): number {
    return this.eidDefs.get(target)?.damageMultipliers?.[kind] ?? this.defs.get(AssetRef.assetHash[target]! >>> 0)?.damageMultipliers?.[kind] ?? 1;
  }

  hasRuin(eid: number): boolean {
    return this.ruins.has(eid);
  }

  /** Whether `holder` at `avatar` may mend ruin `eid` now, and how long it takes. Changes nothing. */
  checkRepair(holder: number, avatar: number, eid: number): RepairCheck {
    const r = this.ruins.get(eid);
    if (!r) return { ok: false, error: "nothing to repair there" };
    const body = r.snap.body;
    const dx = Math.max(0, Math.abs(Transform.px[eid]! - Transform.px[avatar]!) - (body ? body[1]! : 0));
    const dz = Math.max(0, Math.abs(Transform.pz[eid]! - Transform.pz[avatar]!) - (body ? body[3]! : 0));
    const reach = this.opts.repairReachM ?? 3;
    if (dx * dx + dz * dz > reach * reach) return { ok: false, error: "too far away" };
    const need = r.def.repair!;
    if ((this.opts.materials?.count(holder, need.material) ?? 0) < need.count) return { ok: false, error: `mending it takes ${need.count} ${need.material}` };
    return { ok: true, castSeconds: need.castSeconds, spell: "repair" };
  }

  /** Mend ruin `eid`: the same checks again, then the materials go and the building stands whole. */
  repair(sim: SimWorld, holder: number, avatar: number, eid: number): RepairResult {
    const ok = this.checkRepair(holder, avatar, eid);
    if (!ok.ok) return ok;
    const r = this.ruins.get(eid)!;
    const need = r.def.repair!;
    if (!(this.opts.materials?.spend(holder, need.material, need.count) ?? false)) return { ok: false, error: `mending it takes ${need.count} ${need.material}` };
    restore(sim, eid, r.snap, true);
    this.eidDefs.set(eid, r.def);
    if (r.key !== null) {
      this.keys.set(eid, r.key);
      this.opts.store?.clear("break", r.key);
    }
    if (r.poolHandle !== INVALID_POOL_HANDLE && this.pool?.isValidHandle(r.poolHandle)) {
      this.slotToPending.delete(r.poolHandle & 0xffff);
      this.pool.markActive(r.poolHandle, eid, 1);
      this.eidToPoolHandle.set(eid, r.poolHandle);
    }
    // A respawn timer, if it had one, no longer applies.
    if (this.pending.length > 0) this.pending = this.pending.filter((p) => p.eid !== eid);
    this.ruins.delete(eid);
    this.changed.add(eid);
    return { ok: true };
  }

  private view(eid: number, sim: SimWorld): ChestView {
    return { entity: String(sim.wireId(eid)), x: Transform.px[eid]!, z: Transform.pz[eid]!, open: !this.ruins.has(eid), kind: "ruin" };
  }

  /** Every ruin, for a player joining. */
  views(sim: SimWorld): ChestView[] {
    return [...this.ruins.keys()].map((e) => this.view(e, sim));
  }

  /** The ruins that appeared or were mended since the last drain (a mended one comes back `open`: no longer a target). */
  drainChanges(sim: SimWorld): ChestView[] {
    if (this.changed.size === 0) return [];
    const out = [...this.changed].map((e) => this.view(e, sim));
    this.changed = new Set();
    return out;
  }

  /** Custom damage-stage thresholds (DE1), keyed by assetHash or `assetHash:maxHealth`. */
  damageStages(): Record<string, number[]> | undefined {
    const out: Record<string, number[]> = {};
    let any = false;
    for (const [hash, def] of this.defs) {
      if (def.stages && def.stages.length > 0) {
        out[String(hash >>> 0)] = [...def.stages];
        any = true;
      }
    }
    for (const [key, stages] of this.customStages) {
      out[key] = [...stages];
      any = true;
    }
    return any ? out : undefined;
  }

  /** Props whose time has come are back. */
  private respawns(sim: SimWorld): void {
    if (this.pool) {
      const now = this.now();
      const readyCount = this.pool.pollReady(now, this.readyScratch, RespawnKind.BreakableProp, false);
      for (let i = 0; i < readyCount; i++) {
        const idx = this.readyScratch[i]!;
        const p = this.slotToPending.get(idx);
        if (p) {
          this.slotToPending.delete(idx);
          this.restorePending(sim, p);
        } else {
          const mHash = this.pool.modelHash[idx]! >>> 0;
          const aHash = this.pool.archetypeHash[idx]! >>> 0;
          const def = this.defs.get(mHash) ?? this.defs.get(aHash);
          if (def) {
            const handle = this.pool.handleAtSlot(idx);
            const eid = sim.spawn();
            addComponent(sim.ecs, Transform, eid);
            Transform.px[eid] = this.pool.homeX[idx]!;
            Transform.py[eid] = this.pool.homeY[idx]!;
            Transform.pz[eid] = this.pool.homeZ[idx]!;
            Transform.qw[eid] = 1;
            Transform.sx[eid] = Transform.sy[eid] = Transform.sz[eid] = 1;
            addComponent(sim.ecs, AssetRef, eid);
            AssetRef.assetHash[eid] = mHash || aHash;
            AssetRef.variant[eid] = 0;
            addComponent(sim.ecs, Health, eid);
            Health.current[eid] = Health.max[eid] = def.health;
            addComponent(sim.ecs, Breakable, eid);
            const key = this.pool.getKeyAtSlot(idx);
            if (key) {
              if (!key.startsWith("scatter/")) this.keys.set(eid, key);
              this.opts.store?.clear("break", key);
            }
            this.eidDefs.set(eid, def);
            this.eidToPoolHandle.set(eid, handle);
            this.pool.markActive(handle, eid, 1);
          }
        }
      }
    }
    if (this.pending.length === 0) return;
    const now = this.now();
    const later: Pending[] = [];
    for (const p of this.pending) {
      if (now < p.respawnAt) {
        later.push(p);
        continue;
      }
      this.restorePending(sim, p);
    }
    this.pending = later;
  }

  private restorePending(sim: SimWorld, p: Pending): void {
    if (p.debris !== null) sim.despawn(p.debris);
    if (p.eid !== null && this.ruins.delete(p.eid)) this.changed.add(p.eid);
    const eid = p.eid !== null ? p.eid : sim.spawn();
    restore(sim, eid, p.snap, p.eid !== null);
    this.eidDefs.set(eid, p.def);
    if (p.key !== null) {
      if (!p.key.startsWith("scatter/")) this.keys.set(eid, p.key);
      this.opts.store?.clear("break", p.key);
    }
    if (this.pool && p.poolHandle !== INVALID_POOL_HANDLE && this.pool.isValidHandle(p.poolHandle)) {
      this.pool.markActive(p.poolHandle, eid, 1);
      this.eidToPoolHandle.set(eid, p.poolHandle);
    }
  }
}

function capture(sim: SimWorld, eid: number): Snap {
  return {
    tf: TF.map((f) => Transform[f][eid]!),
    assetHash: AssetRef.assetHash[eid]!,
    variant: AssetRef.variant[eid]!,
    body: hasComponent(sim.ecs, BodyConfig, eid) ? BODY.map((f) => BodyConfig[f][eid]!) : null,
    hp: Health.max[eid]!,
  };
}

/** Put a prop back: onto its own entity (`existing`: it was left standing broken) or a new one. */
function restore(sim: SimWorld, eid: number, s: Snap, existing: boolean): void {
  if (!existing) {
    addComponent(sim.ecs, Transform, eid);
    TF.forEach((f, i) => (Transform[f][eid] = s.tf[i]!));
    addComponent(sim.ecs, AssetRef, eid);
    AssetRef.assetHash[eid] = s.assetHash;
  }
  AssetRef.variant[eid] = s.variant;
  if (s.body && !hasComponent(sim.ecs, BodyConfig, eid)) {
    addComponent(sim.ecs, Velocity, eid);
    Velocity.lx[eid] = Velocity.ly[eid] = Velocity.lz[eid] = Velocity.ax[eid] = Velocity.ay[eid] = Velocity.az[eid] = 0;
    addComponent(sim.ecs, BodyConfig, eid);
    BODY.forEach((f, i) => (BodyConfig[f][eid] = s.body![i]!));
  }
  if (!hasComponent(sim.ecs, Health, eid)) addComponent(sim.ecs, Health, eid);
  Health.current[eid] = Health.max[eid] = s.hp;
  addComponent(sim.ecs, Breakable, eid);
}
