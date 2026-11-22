/**
 * GatheringSystem: the resource nodes round the towns (tree stands, ore
 * veins, fishing spots; a scene node's ResourceNode component) and what
 * players gather from them into their materials pouch.
 *
 * The server owns every node's stock. A gather takes one from it into the
 * gatherer's pouch and trains the node's skill; a node with none left is
 * worked out until its regrow time has passed (never, for ore). Stocks and
 * pouches write through to a GatheringStore, so a worked-out node stays
 * worked out across restarts and comes back on the wall clock, not the tick.
 *
 * Nodes are keyed by their scene node id: a reboot respawns the scene's
 * entities, and each node finds its stock again by key.
 */

import { BUILTIN_MATERIALS } from "@mmo-engine/crafting";
import { z } from "zod";
import type { GatheringRules } from "@mmo-engine/rules";
import type { PouchMaterial, PouchMessage, ResourceNodeView } from "@mmo-engine/protocol";
import { Transform } from "../components.js";
import { INVALID_POOL_HANDLE, RespawnKind, SlotState, type SpawnPoolSoA } from "../pools/spawn-pool-soa.js";
import type { SimSystem } from "../systems.js";
import type { SystemAccess } from "../system-access.js";
import type { SimWorld } from "../world.js";
import { PORTS } from "@mmo-engine/sdk";

export interface GatheringStore {
  /** A node's saved stock and regrow time (unix ms; null: none due), or undefined when never saved. */
  loadNode(key: string): { stock: number; regrowAt: number | null } | undefined;
  saveNode(key: string, stock: number, regrowAt: number | null): void;
  /** A character's pouch: material id -> count. */
  loadPouch(charId: number): Record<string, number>;
  savePouch(charId: number, material: string, count: number): void;
}

/** What a scene's ResourceNode component says about a node. */
export interface ResourceNodeSpec {
  kind: string;
  material: string;
  tier: number;
  skill: string;
  stock: number;
  regrowHours: number;
  /** Half the node's footprint, metres: the gather range is measured from its edge. */
  halfX: number;
  halfZ: number;
}

export interface GatheringOptions {
  store?: GatheringStore;
  /** Reach beyond the node's edge, metres. */
  reachM?: number;
  /** One gather per character this often, ms. */
  cooldownMs?: number;
  /** Most of one material a pouch holds. */
  pouchMax?: number;
  /** Wall clock (unix ms); tests pass their own. */
  now?: () => number;
  /** Training difficulty per material tier (capped at 1). */
  trainPerTier?: number;
  /** Worked-out nodes are checked for regrowth this often, seconds. Default 1. */
  regrowCheckSeconds?: number;
  /** Real milliseconds in one of a node's regrow hours. Default an hour. */
  regrowHourMs?: number;
  /** Train the gatherer's skill (lowercase id, e.g. "mining") at a difficulty 0..1 against a target key. */
  train?: (avatar: number, skill: string, difficulty: number, key: number) => void;
  /** Optional SAB SpawnPoolSoA mirroring resource node stock and regrowth timers. */
  pool?: SpawnPoolSoA;
}

export type GatherResult =
  | { ok: true; material: string; name: string; count: number }
  | { ok: false; error: string };

interface Node extends ResourceNodeSpec {
  key: string;
  eid: number;
  name: string;
  max: number;
  regrowAt: number | null;
  poolHandle: number;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
const HOUR_MS = 3_600_000;

/** A material's name: the crafting material's, else its id in words ("sea-fish" -> "Sea fish"). */
export function materialName(id: string): string {
  const m = BUILTIN_MATERIALS[id];
  if (m) return m.name;
  const words = id.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export class GatheringSystem implements SimSystem {
  /** Offered to the host as the `gathering` port: its resource nodes and the pouch they fill. */
  readonly [PORTS] = ["gathering"];
  readonly name = "gathering";
  readonly access: SystemAccess = {
    system: "gathering",
    reads: [
      { component: "Transform", fields: ["px", "pz"] },
    ],
    writes: [],
  };
  private readonly nodes = new Map<number, Node>();
  private readonly pouches = new Map<number, Map<string, number>>();
  private readonly lastGather = new Map<number, number>();
  private readonly slotToNode = new Map<number, Node>();
  private readonly pool?: SpawnPoolSoA;
  private readonly readyScratch: Int32Array;
  private changed = new Set<Node>();
  private reachM: number;
  private cooldownMs: number;
  /** How long one gather takes, seconds (the cast bar); set by setRules. */
  castSeconds = 0;
  private pouchMax: number;
  private trainPerTier: number;
  private regrowCheckSeconds: number;
  private regrowHourMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: GatheringOptions = {}) {
    this.reachM = opts.reachM ?? 2.5;
    this.cooldownMs = opts.cooldownMs ?? 1200;
    this.pouchMax = opts.pouchMax ?? 999;
    this.trainPerTier = opts.trainPerTier ?? 0.2;
    this.regrowCheckSeconds = opts.regrowCheckSeconds ?? 1;
    this.regrowHourMs = opts.regrowHourMs ?? HOUR_MS;
    this.now = opts.now ?? Date.now;
    this.pool = opts.pool;
    this.readyScratch = opts.pool
      ? new Int32Array(Math.max(64, opts.pool.capacity))
      : new Int32Array(0);
  }

  /** Apply gathering.json on a rules reload (EG11). A node already worked out keeps the regrow time it was given. */
  setRules(r: GatheringRules): void {
    this.reachM = r.reachM;
    this.cooldownMs = r.cooldownSeconds * 1000;
    this.castSeconds = r.castSeconds;
    this.pouchMax = r.pouchMax;
    this.trainPerTier = r.trainDifficultyPerTier;
    this.regrowCheckSeconds = r.regrowCheckSeconds;
    this.regrowHourMs = r.regrowHourSeconds * 1000;
    if (this.pool) {
      for (const node of this.nodes.values()) {
        if (node.poolHandle !== INVALID_POOL_HANDLE && this.pool.isValidHandle(node.poolHandle)) {
          this.pool.respawnDelayMs[node.poolHandle & 0xffff] =
            node.regrowHours > 0 ? node.regrowHours * this.regrowHourMs : 0;
        }
      }
    }
  }

  /** Packed `SpawnPoolSoA` slot handle for resource node `eid`, or `0` (`INVALID_POOL_HANDLE`) if absent. */
  poolSlotOf(eid: number): number {
    return this.nodes.get(eid)?.poolHandle ?? INVALID_POOL_HANDLE;
  }

  /** Make entity `eid` the resource node `key`: its saved stock if it has one, else full. */
  register(eid: number, key: string, spec: ResourceNodeSpec): void {
    const max = Math.max(0, Math.round(spec.stock));
    const saved = this.opts.store?.loadNode(key);
    let stock = saved ? Math.min(max, Math.max(0, saved.stock)) : max;
    let regrowAt: number | null = saved && stock === 0 ? saved.regrowAt : null;
    let poolHandle = INVALID_POOL_HANDLE;

    if (this.pool) {
      const existingHandle = this.pool.findByKey(key);
      const defaultDelayMs = spec.regrowHours > 0 ? spec.regrowHours * this.regrowHourMs : 0;
      if (existingHandle === INVALID_POOL_HANDLE) {
        const px = Transform.px[eid];
        const py = Transform.py[eid];
        const pz = Transform.pz[eid];
        const initState =
          stock > 0
            ? SlotState.Active
            : regrowAt !== null
              ? SlotState.CooldownRespawn
              : SlotState.Exhausted;
        poolHandle = this.pool.allocateSlot({
          key,
          kind: RespawnKind.ResourceNode,
          state: initState,
          archetypeId: spec.kind,
          modelId: spec.material,
          liveEid: eid,
          stock,
          maxStock: max,
          homeX: Number.isFinite(px) ? px! : 0,
          homeY: Number.isFinite(py) ? py! : 0,
          homeZ: Number.isFinite(pz) ? pz! : 0,
          footprintRadiusM: Math.max(0, spec.halfX, spec.halfZ),
          respawnDelayMs: defaultDelayMs,
          respawnAtMs: initState === SlotState.CooldownRespawn ? (regrowAt ?? Number.NaN) : Number.NaN,
        });
      } else {
        poolHandle = existingHandle;
        const idx = poolHandle & 0xffff;
        if (!saved) {
          const st = this.pool.state[idx]!;
          if (st === SlotState.CooldownRespawn) {
            stock = 0;
            regrowAt = Number.isFinite(this.pool.respawnAtMs[idx]!) ? this.pool.respawnAtMs[idx]! : null;
            this.pool.setLiveEid(poolHandle, eid);
          } else if (st === SlotState.Exhausted) {
            stock = 0;
            regrowAt = null;
            this.pool.setLiveEid(poolHandle, eid);
          } else {
            if (this.pool.maxStock[idx]! === 0 && max > 0) {
              this.pool.maxStock[idx] = max;
              this.pool.stock[idx] = max;
            }
            stock = Math.min(max, Math.max(0, this.pool.stock[idx]!));
            regrowAt = null;
            this.pool.markActive(poolHandle, eid, stock);
          }
        } else if (stock > 0) {
          this.pool.markActive(poolHandle, eid, stock);
        } else if (regrowAt !== null) {
          const now = this.now();
          if (now >= regrowAt) {
            this.pool.scheduleRespawn(poolHandle, regrowAt, 0);
          } else {
            this.pool.scheduleRespawn(poolHandle, now, regrowAt - now);
          }
        } else {
          this.pool.stock[idx] = 0;
          this.pool.state[idx] = SlotState.Exhausted;
          this.pool.respawnAtMs[idx] = Number.NaN;
          this.pool.liveEid[idx] = -1;
        }
        if (this.pool.respawnDelayMs[idx]! === 0 && defaultDelayMs > 0) {
          this.pool.respawnDelayMs[idx] = defaultDelayMs;
        }
      }
    }

    const node: Node = {
      ...spec,
      key,
      eid,
      name: materialName(spec.material),
      max,
      stock,
      regrowAt,
      poolHandle,
    };
    this.nodes.set(eid, node);
    if (poolHandle !== INVALID_POOL_HANDLE) {
      this.slotToNode.set(poolHandle & 0xffff, node);
    }
    // A node that came back while the server was down is full again.
    this.regrow(node);
  }

  /** Whether entity `eid` is a resource node. */
  has(eid: number): boolean {
    return this.nodes.has(eid);
  }

  get size(): number {
    return this.nodes.size;
  }

  /** Gather once from node `eid` as character `holder`, whose avatar is entity `avatar`. */
  gather(_sim: SimWorld, holder: number, avatar: number, eid: number, dryRun = false): GatherResult {
    const node = eid < 0 ? undefined : this.nodes.get(eid);
    if (!node) return { ok: false, error: "nothing to gather there" };
    const dx = Math.max(0, Math.abs(Transform.px[eid]! - Transform.px[avatar]!) - node.halfX);
    const dz = Math.max(0, Math.abs(Transform.pz[eid]! - Transform.pz[avatar]!) - node.halfZ);
    if (dx * dx + dz * dz > this.reachM * this.reachM) return { ok: false, error: "too far away" };
    const now = this.now();
    if (now - (this.lastGather.get(holder) ?? -Infinity) < this.cooldownMs) return { ok: false, error: "still gathering" };
    if (node.stock <= 0) {
      if (node.regrowAt === null) return { ok: false, error: `the ${node.name.toLowerCase()} here is worked out for good` };
      const hours = Math.max(1, Math.ceil((node.regrowAt - now) / this.regrowHourMs));
      return { ok: false, error: `worked out: it comes back in about ${hours} hour${hours === 1 ? "" : "s"}` };
    }
    const pouch = this.pouchOf(holder);
    const have = pouch.get(node.material) ?? 0;
    if (have >= this.pouchMax) return { ok: false, error: `your pouch holds no more ${node.name.toLowerCase()}` };
    if (dryRun) return { ok: true, material: node.material, name: node.name, count: 0 };
    this.lastGather.set(holder, now);
    node.stock -= 1;
    if (this.pool && node.poolHandle !== INVALID_POOL_HANDLE && this.pool.isValidHandle(node.poolHandle)) {
      this.pool.decrementStock(node.poolHandle, 1, now);
      if (node.stock === 0) {
        const idx = node.poolHandle & 0xffff;
        node.regrowAt =
          this.pool.state[idx] === SlotState.CooldownRespawn && Number.isFinite(this.pool.respawnAtMs[idx]!)
            ? this.pool.respawnAtMs[idx]!
            : null;
      }
    } else if (node.stock === 0) {
      node.regrowAt = node.regrowHours > 0 ? now + node.regrowHours * this.regrowHourMs : null;
    }
    this.opts.store?.saveNode(node.key, node.stock, node.regrowAt);
    pouch.set(node.material, have + 1);
    if (holder >= 0) this.opts.store?.savePouch(holder, node.material, have + 1);
    this.changed.add(node);
    this.opts.train?.(avatar, node.skill.toLowerCase(), Math.min(1, node.tier * this.trainPerTier), eid);
    return { ok: true, material: node.material, name: node.name, count: 1 };
  }

  /** Worked-out nodes whose time has come grow back. */
  step(sim: SimWorld, dt: number): void {
    if (sim.currentTick % Math.max(1, Math.round(this.regrowCheckSeconds / dt)) !== 0) return;
    const nowMs = this.now();
    if (this.pool) {
      const readyCount = this.pool.pollReady(nowMs, this.readyScratch, RespawnKind.ResourceNode, false);
      for (let i = 0; i < readyCount; i++) {
        const node = this.slotToNode.get(this.readyScratch[i]!);
        if (node) this.applyRegrow(node);
      }
      if (this.slotToNode.size < this.nodes.size) {
        for (const node of this.nodes.values()) {
          if (node.poolHandle === INVALID_POOL_HANDLE) this.regrow(node, nowMs);
        }
      }
      return;
    }
    for (const node of this.nodes.values()) this.regrow(node, nowMs);
  }

  private regrow(node: Node, nowMs = this.now()): void {
    if (node.stock > 0 || node.regrowAt === null || nowMs < node.regrowAt) return;
    this.applyRegrow(node);
  }

  private applyRegrow(node: Node): void {
    node.stock = node.max;
    node.regrowAt = null;
    if (this.pool && node.poolHandle !== INVALID_POOL_HANDLE && this.pool.isValidHandle(node.poolHandle)) {
      this.pool.markActive(node.poolHandle, node.eid, node.max);
    }
    this.opts.store?.saveNode(node.key, node.stock, null);
    this.changed.add(node);
  }

  /** Every node, as the client sees it. */
  views(sim: SimWorld): ResourceNodeView[] {
    return [...this.nodes.values()].map((n) => this.view(sim, n));
  }

  /** The nodes that changed since the last drain. */
  drainChanges(sim: SimWorld): ResourceNodeView[] {
    if (this.changed.size === 0) return [];
    const out = [...this.changed].map((n) => this.view(sim, n));
    this.changed = new Set();
    return out;
  }

  private view(sim: SimWorld, n: Node): ResourceNodeView {
    return { entity: sim.wireId(n.eid).toString(), kind: n.kind, material: n.material, name: n.name, tier: n.tier, skill: n.skill, stock: n.stock, max: n.max, size: [round2(n.halfX * 2), round2(n.halfZ * 2)], regrowAt: n.stock > 0 ? null : n.regrowAt };
  }

  /** Character `holder`'s pouch, highest tier first, then by name. */
  pouchMessage(holder: number, gathered?: PouchMessage["gathered"]): PouchMessage {
    const materials: PouchMaterial[] = [...this.pouchOf(holder)]
      .filter(([, count]) => count > 0)
      .map(([material, count]) => ({ material, name: materialName(material), tier: BUILTIN_MATERIALS[material]?.tier ?? this.tierOf(material), count }))
      .sort((a, b) => b.tier - a.tier || a.name.localeCompare(b.name));
    return { kind: "pouch", materials, ...(gathered ? { gathered } : {}) };
  }

  /** Drop `holder`'s cached pouch: the store was just given the world's copy (PL3b), read it again on next touch. */
  forgetPouch(holder: number): void {
    this.pouches.delete(holder);
  }

  /** Use `qty` of `material` up from `holder`'s pouch (a repair). False, and nothing spent, when they have less. */
  spend(holder: number, material: string, qty: number): boolean {
    const pouch = this.pouchOf(holder);
    const have = pouch.get(material) ?? 0;
    if (have < qty) return false;
    if (have === qty) pouch.delete(material);
    else pouch.set(material, have - qty);
    if (holder >= 0) this.opts.store?.savePouch(holder, material, have - qty);
    return true;
  }

  /** How many of `material` character `holder` has. */
  countOf(holder: number, material: string): number {
    return this.pouchOf(holder).get(material) ?? 0;
  }

  /** Whether `holder`'s pouch has room for `qty` more units of `material`. */
  hasRoom(holder: number, material: string, qty: number): boolean {
    if (!Number.isInteger(qty) || qty <= 0) return false;
    return this.countOf(holder, material) + qty <= this.pouchMax;
  }

  /** Add `qty` of `material` to `holder`'s pouch, written through to the store; false when full or invalid. */
  grant(holder: number, material: string, qty: number): boolean {
    if (!Number.isInteger(qty) || qty <= 0) return false;
    const pouch = this.pouchOf(holder);
    const have = pouch.get(material) ?? 0;
    if (have + qty > this.pouchMax) return false;
    pouch.set(material, have + qty);
    if (holder >= 0) this.opts.store?.savePouch(holder, material, have + qty);
    return true;
  }

  /** Spend `qty` of `material` from `holder`'s pouch (crafting), written through to the store; false and no change when short. */
  take(holder: number, material: string, qty: number): boolean {
    const pouch = this.pouchOf(holder);
    const have = pouch.get(material) ?? 0;
    if (!Number.isInteger(qty) || qty < 0 || have < qty) return false;
    pouch.set(material, have - qty);
    if (holder >= 0) this.opts.store?.savePouch(holder, material, have - qty);
    return true;
  }

  private tierOf(material: string): number {
    for (const n of this.nodes.values()) if (n.material === material) return n.tier;
    return 1;
  }

  private pouchOf(holder: number): Map<string, number> {
    let p = this.pouches.get(holder);
    if (!p) {
      p = new Map(holder >= 0 ? Object.entries(this.opts.store?.loadPouch(holder) ?? {}) : []);
      this.pouches.set(holder, p);
    }
    return p;
  }
}
