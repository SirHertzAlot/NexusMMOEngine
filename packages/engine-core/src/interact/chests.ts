/**
 * World chests and doors (IX1, IX3): a scene Structure with a `Chest` or
 * `Door` component.
 *
 * A chest is shared: the first player to open it gets its loot table on the
 * ground beside it, owned by them for the loot rules' ownership time; it is
 * empty until its refill timer comes due, then full for whoever comes next.
 * A door toggles: opening it lets go of its collider (the physics system's
 * membership diff drops the body), closing it puts the body back.
 *
 * Either can take time (`castSeconds`: the gateway runs the cast bar and
 * cancels it on a move, a blow or a death) and can need an item
 * (`requires`: a key in the bag, used up or kept). State lives in memory (a
 * restart refills every chest and closes every door; persistence is IX5's
 * place record).
 */

import { z } from "zod";
import { addComponent, hasComponent, removeComponent } from "bitecs";
import { BodyConfig, Transform } from "../components.js";
import { INVALID_POOL_HANDLE, RespawnKind, SlotState, type SpawnPoolSoA } from "../pools/spawn-pool-soa.js";
import type { SimWorld } from "../world.js";
import type { SimSystem } from "../systems.js";
import type { SystemAccess } from "../system-access.js";
import type { ChestView } from "@mmo-engine/protocol";
import type { PlacesStore } from "./places-store.js";
import { PORTS } from "@mmo-engine/sdk";
import type { ChestCheck, ChestResult } from "../vocabulary.js";

/** An interact request (catalog 0x27): an entity's wire id, or a quest giver's or dungeon entrance's content id. */
const contentId = z.string().min(1).max(64);
export const InteractActionSchema = z.union([
  z.object({ kind: z.literal("interact"), entity: z.string().regex(/^\d{1,20}$/) }).strict(),
  z.object({ kind: z.literal("interact"), npc: contentId }).strict(),
  z.object({ kind: z.literal("interact"), entrance: contentId }).strict(),
]);

export interface ChestSpec {
  /** "chest" (default) rolls `table` when opened; a "door" toggles open and shut. */
  kind?: "chest" | "door";
  /** A loot.json table the chest rolls when opened. */
  table?: string;
  /** Seconds until an opened chest is full again. */
  refillSeconds?: number;
  /** Seconds the use takes (a cast bar); 0 or absent: at once. */
  castSeconds?: number;
  /** An item base the user must carry (a key); `consume` uses one up when it opens. */
  requires?: { base: string; consume: boolean };
}

export interface ChestSystemOptions {
  /** Put the table's items on the ground at (x, z), owned by `owner`; returns how many. */
  drop: (sim: SimWorld, table: string, x: number, z: number, owner: number) => number;
  /** Whether character `holder` carries an item of `base` in the bag. */
  has?: (holder: number, base: string) => boolean;
  /** Use one item of `base` up from `holder`'s bag; false if there is none. */
  take?: (holder: number, base: string) => boolean;
  /** How close a player must be to the chest's centre, metres. Default 3. */
  reachM?: number;
  /** Where open chests and doors are kept across a restart (IX5). */
  store?: PlacesStore;
  /** Optional SAB SpawnPoolSoA mirroring chest refill timers. */
  pool?: SpawnPoolSoA;
  now?: () => number;
}

const BODY_FIELDS = ["shapeKind", "halfX", "halfY", "halfZ", "radius", "mass", "motionType", "layer", "friction", "restitution"] as const;

interface Chest extends ChestSpec {
  eid: number;
  key: string;
  /** Chests: when it is full again; null: full now. */
  refillAt: number | null;
  /** Doors: whether it stands open. */
  doorOpen: boolean;
  /** Doors: the collider, kept while it is open. */
  body: number[] | null;
  poolHandle: number;
}

export class ChestSystem implements SimSystem {
  /** Offered to the host as the `chests` port: its chests and the doors they open. */
  readonly [PORTS] = ["chests"];
  readonly name = "chests";
  readonly access: SystemAccess = {
    system: "chests",
    reads: [
      "BodyConfig",
      { component: "Transform", fields: ["px", "pz"] },
    ],
    writes: ["BodyConfig"],
  };
  private readonly chests = new Map<number, Chest>();
  private readonly slotToChest = new Map<number, Chest>();
  private readonly pool?: SpawnPoolSoA;
  private readonly readyScratch: Int32Array;
  private changed = new Set<Chest>();
  private readonly reachM: number;
  private readonly now: () => number;

  constructor(private readonly opts: ChestSystemOptions) {
    this.reachM = opts.reachM ?? 3;
    this.now = opts.now ?? Date.now;
    this.pool = opts.pool;
    this.readyScratch = opts.pool
      ? new Int32Array(Math.max(64, opts.pool.capacity))
      : new Int32Array(0);
  }

  /** Packed `SpawnPoolSoA` slot handle for chest `eid`, or `0` (`INVALID_POOL_HANDLE`) if absent. */
  poolSlotOf(eid: number): number {
    return this.chests.get(eid)?.poolHandle ?? INVALID_POOL_HANDLE;
  }

  /** Make a spawned entity a chest or door; `sim` lets a door that was left open open again. What the store remembers is applied. */
  register(eid: number, key: string, spec: ChestSpec, sim?: SimWorld): void {
    const c: Chest = {
      ...spec,
      eid,
      key,
      refillAt: null,
      doorOpen: false,
      body: null,
      poolHandle: INVALID_POOL_HANDLE,
    };
    this.chests.set(eid, c);
    const rec = this.opts.store?.load("chest", key);
    if (c.kind === "door") {
      if (rec && sim) this.setDoor(sim, c, true);
      else if (rec && !sim) return;
      return;
    }

    const now = this.now();
    if (rec) {
      if (rec.respawnAt !== null && now < rec.respawnAt) {
        c.refillAt = rec.respawnAt;
      } else {
        this.opts.store!.clear("chest", key); // refilled while the server was down
      }
    }

    if (this.pool) {
      const existing = this.pool.findByKey(key);
      const delayMs = spec.refillSeconds !== undefined ? Math.max(0, spec.refillSeconds * 1000) : 600_000;
      let handle = existing;
      if (handle === INVALID_POOL_HANDLE) {
        const px = Transform.px[eid];
        const py = Transform.py[eid];
        const pz = Transform.pz[eid];
        const inCooldown = c.refillAt !== null;
        handle = this.pool.allocateSlot({
          key,
          kind: RespawnKind.Chest,
          state: inCooldown ? SlotState.CooldownRespawn : SlotState.Active,
          archetypeId: spec.table ?? "chest",
          liveEid: inCooldown ? -1 : eid,
          stock: inCooldown ? 0 : 1,
          maxStock: 1,
          homeX: Number.isFinite(px) ? px! : 0,
          homeY: Number.isFinite(py) ? py! : 0,
          homeZ: Number.isFinite(pz) ? pz! : 0,
          respawnDelayMs: delayMs,
          respawnAtMs: inCooldown ? c.refillAt! : Number.NaN,
        });
      } else if (rec) {
        if (c.refillAt !== null) {
          this.pool.scheduleRespawn(handle, now, Math.max(0, c.refillAt - now));
        } else {
          this.pool.markActive(handle, eid, 1);
        }
      } else {
        const idx = handle & 0xffff;
        if (this.pool.state[idx] === SlotState.CooldownRespawn && Number.isFinite(this.pool.respawnAtMs[idx]!)) {
          if (now >= this.pool.respawnAtMs[idx]!) {
            c.refillAt = null;
            this.pool.markActive(handle, eid, 1);
          } else {
            c.refillAt = this.pool.respawnAtMs[idx]!;
          }
        } else {
          this.pool.markActive(handle, eid, 1);
        }
        if (this.pool.respawnDelayMs[idx]! === 0 && spec.refillSeconds !== undefined) {
          this.pool.respawnDelayMs[idx] = delayMs;
        }
      }
      if (handle !== INVALID_POOL_HANDLE) {
        c.poolHandle = handle;
        this.slotToChest.set(handle & 0xffff, c);
      }
    }
  }

  has(eid: number): boolean {
    return this.chests.has(eid);
  }

  /** The chest's entity changed (a run swaps an opened chest for an open model): same state, new entity, and clients hear of it. */
  rebind(oldEid: number, newEid: number): void {
    const c = this.chests.get(oldEid);
    if (!c) return;
    this.chests.delete(oldEid);
    this.changed.delete(c);
    c.eid = newEid;
    this.chests.set(newEid, c);
    if (this.pool && c.poolHandle !== INVALID_POOL_HANDLE && this.pool.isValidHandle(c.poolHandle)) {
      if (c.refillAt === null) this.pool.setLiveEid(c.poolHandle, newEid);
    }
    this.changed.add(c);
  }

  /** Whether chest `eid` is open now (a chest: until it refills; a door: until shut). */
  isOpen(eid: number): boolean {
    const c = this.chests.get(eid);
    return c !== undefined && (c.kind === "door" ? c.doorOpen : c.refillAt !== null);
  }

  get size(): number {
    return this.chests.size;
  }

  /** Whether `holder` at `avatar` may use `eid` now; says how long it takes. Changes nothing. */
  check(_sim: SimWorld, holder: number, avatar: number, eid: number): ChestCheck {
    const c = eid < 0 ? undefined : this.chests.get(eid);
    if (!c) return { ok: false, error: "nothing to open there" };
    const dx = Transform.px[eid]! - Transform.px[avatar]!;
    const dz = Transform.pz[eid]! - Transform.pz[avatar]!;
    if (dx * dx + dz * dz > this.reachM * this.reachM) return { ok: false, error: "too far away" };
    const door = c.kind === "door";
    if (!door && c.refillAt !== null) return { ok: false, error: "the chest is empty" };
    // Shutting a door needs no key; opening anything does.
    if (c.requires && !(door && c.doorOpen) && !(this.opts.has?.(holder, c.requires.base) ?? false)) return { ok: false, error: locked(c) };
    return { ok: true, castSeconds: c.castSeconds ?? 0, spell: door ? "door" : "chest" };
  }

  /** Use chest or door `eid`: the same checks again (the world moved on while the bar filled), then the effect. */
  open(sim: SimWorld, holder: number, avatar: number, eid: number): ChestResult {
    const ok = this.check(sim, holder, avatar, eid);
    if (!ok.ok) return ok;
    const c = this.chests.get(eid)!;
    const opening = c.kind === "door" ? !c.doorOpen : true;
    if (opening && c.requires?.consume && !(this.opts.take?.(holder, c.requires.base) ?? false)) return { ok: false, error: locked(c) };
    if (c.kind === "door") {
      this.setDoor(sim, c, !c.doorOpen);
      if (c.doorOpen) this.opts.store?.save({ kind: "chest", key: c.key, state: "open", at: this.now(), respawnAt: null });
      else this.opts.store?.clear("chest", c.key);
      return { ok: true, items: 0 };
    }
    const now = this.now();
    if (this.pool && c.poolHandle !== INVALID_POOL_HANDLE && this.pool.isValidHandle(c.poolHandle)) {
      const idx = c.poolHandle & 0xffff;
      const delayMs =
        c.refillSeconds !== undefined
          ? Math.max(0, c.refillSeconds * 1000)
          : this.pool.respawnDelayMs[idx]! > 0
            ? this.pool.respawnDelayMs[idx]!
            : 600_000;
      this.pool.stock[idx] = 0;
      this.pool.scheduleRespawn(c.poolHandle, now, delayMs);
      c.refillAt = this.pool.respawnAtMs[idx]!;
    } else {
      c.refillAt = now + (c.refillSeconds ?? 600) * 1000;
    }
    this.opts.store?.save({ kind: "chest", key: c.key, state: "open", at: now, respawnAt: c.refillAt });
    this.changed.add(c);
    return { ok: true, items: this.opts.drop(sim, c.table ?? "", Transform.px[eid]!, Transform.pz[eid]!, holder > 0 ? holder : 0) };
  }

  /** An open door has no body; a shut one gets it back. */
  private setDoor(sim: SimWorld, c: Chest, open: boolean): void {
    if (open) {
      if (hasComponent(sim.ecs, BodyConfig, c.eid)) {
        c.body = BODY_FIELDS.map((f) => BodyConfig[f][c.eid]!);
        removeComponent(sim.ecs, BodyConfig, c.eid);
      }
    } else if (c.body) {
      addComponent(sim.ecs, BodyConfig, c.eid);
      BODY_FIELDS.forEach((f, i) => (BodyConfig[f][c.eid] = c.body![i]!));
      c.body = null;
    }
    c.doorOpen = open;
    this.changed.add(c);
  }

  /** Chests whose timer has come due are full again. */
  step(): void {
    const now = this.now();
    if (this.pool) {
      const readyCount = this.pool.pollReady(now, this.readyScratch, RespawnKind.Chest, false);
      for (let i = 0; i < readyCount; i++) {
        const c = this.slotToChest.get(this.readyScratch[i]!);
        if (!c) continue;
        c.refillAt = null;
        this.pool.markActive(c.poolHandle, c.eid, 1);
        this.opts.store?.clear("chest", c.key);
        this.changed.add(c);
      }
      if (this.slotToChest.size < this.chests.size) {
        for (const c of this.chests.values()) {
          if (c.poolHandle === INVALID_POOL_HANDLE && c.refillAt !== null && now >= c.refillAt) {
            c.refillAt = null;
            this.opts.store?.clear("chest", c.key);
            this.changed.add(c);
          }
        }
      }
      return;
    }
    for (const c of this.chests.values()) {
      if (c.refillAt !== null && now >= c.refillAt) {
        c.refillAt = null;
        this.opts.store?.clear("chest", c.key);
        this.changed.add(c);
      }
    }
  }

  private view(sim: SimWorld, c: Chest): ChestView {
    return {
      entity: String(sim.wireId(c.eid)),
      x: Transform.px[c.eid]!,
      z: Transform.pz[c.eid]!,
      open: c.kind === "door" ? c.doorOpen : c.refillAt !== null,
      ...(c.kind === "door" ? { kind: "door" as const } : {}),
    };
  }

  views(sim: SimWorld): ChestView[] {
    return [...this.chests.values()].map((c) => this.view(sim, c));
  }

  /** The chests and doors that changed since the last drain. */
  drainChanges(sim: SimWorld): ChestView[] {
    if (this.changed.size === 0) return [];
    const out = [...this.changed].map((c) => this.view(sim, c));
    this.changed = new Set();
    return out;
  }
}

const locked = (c: Chest): string => `it is locked: you need a ${c.requires!.base}`;
