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
import type { PouchMaterial, PouchMessage, ResourceNodeView } from "@mmo-engine/protocol";
import { Transform } from "../components.js";
import type { SimSystem } from "../systems.js";
import type { SimWorld } from "../world.js";

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
  /** Train the gatherer's skill (lowercase id, e.g. "mining") at a difficulty 0..1 against a target key. */
  train?: (avatar: number, skill: string, difficulty: number, key: number) => void;
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
}

/** A gather request (catalog 0x24): the node's wire id. */
export const GatherActionSchema = z.object({ kind: z.literal("gather"), entity: z.string().regex(/^\d{1,20}$/) }).strict();

const round2 = (v: number): number => Math.round(v * 100) / 100;
const HOUR_MS = 3_600_000;
/** Regrow checks this often, ticks (once a second at 30 Hz). */
const REGROW_EVERY = 30;

/** A material's name: the crafting material's, else its id in words ("sea-fish" -> "Sea fish"). */
export function materialName(id: string): string {
  const m = BUILTIN_MATERIALS[id];
  if (m) return m.name;
  const words = id.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export class GatheringSystem implements SimSystem {
  readonly name = "gathering";
  private readonly nodes = new Map<number, Node>();
  private readonly pouches = new Map<number, Map<string, number>>();
  private readonly lastGather = new Map<number, number>();
  private changed = new Set<Node>();
  private readonly reachM: number;
  private readonly cooldownMs: number;
  private readonly pouchMax: number;
  private readonly now: () => number;

  constructor(private readonly opts: GatheringOptions = {}) {
    this.reachM = opts.reachM ?? 2.5;
    this.cooldownMs = opts.cooldownMs ?? 1200;
    this.pouchMax = opts.pouchMax ?? 999;
    this.now = opts.now ?? Date.now;
  }

  /** Make entity `eid` the resource node `key`: its saved stock if it has one, else full. */
  register(eid: number, key: string, spec: ResourceNodeSpec): void {
    const max = Math.max(0, Math.round(spec.stock));
    const saved = this.opts.store?.loadNode(key);
    const stock = saved ? Math.min(max, Math.max(0, saved.stock)) : max;
    const node: Node = { ...spec, key, eid, name: materialName(spec.material), max, stock, regrowAt: saved && stock === 0 ? saved.regrowAt : null };
    this.nodes.set(eid, node);
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
  gather(_sim: SimWorld, holder: number, avatar: number, eid: number): GatherResult {
    const node = eid < 0 ? undefined : this.nodes.get(eid);
    if (!node) return { ok: false, error: "nothing to gather there" };
    const dx = Math.max(0, Math.abs(Transform.px[eid]! - Transform.px[avatar]!) - node.halfX);
    const dz = Math.max(0, Math.abs(Transform.pz[eid]! - Transform.pz[avatar]!) - node.halfZ);
    if (dx * dx + dz * dz > this.reachM * this.reachM) return { ok: false, error: "too far away" };
    const now = this.now();
    if (now - (this.lastGather.get(holder) ?? -Infinity) < this.cooldownMs) return { ok: false, error: "still gathering" };
    if (node.stock <= 0) {
      if (node.regrowAt === null) return { ok: false, error: `the ${node.name.toLowerCase()} here is worked out for good` };
      const hours = Math.max(1, Math.ceil((node.regrowAt - now) / HOUR_MS));
      return { ok: false, error: `worked out: it comes back in about ${hours} hour${hours === 1 ? "" : "s"}` };
    }
    const pouch = this.pouchOf(holder);
    const have = pouch.get(node.material) ?? 0;
    if (have >= this.pouchMax) return { ok: false, error: `your pouch holds no more ${node.name.toLowerCase()}` };
    this.lastGather.set(holder, now);
    node.stock -= 1;
    if (node.stock === 0) node.regrowAt = node.regrowHours > 0 ? now + node.regrowHours * HOUR_MS : null;
    this.opts.store?.saveNode(node.key, node.stock, node.regrowAt);
    pouch.set(node.material, have + 1);
    if (holder >= 0) this.opts.store?.savePouch(holder, node.material, have + 1);
    this.changed.add(node);
    this.opts.train?.(avatar, node.skill.toLowerCase(), Math.min(1, node.tier * (this.opts.trainPerTier ?? 0.2)), eid);
    return { ok: true, material: node.material, name: node.name, count: 1 };
  }

  /** Worked-out nodes whose time has come grow back. */
  step(sim: SimWorld, _dt: number): void {
    if (sim.currentTick % REGROW_EVERY !== 0) return;
    for (const node of this.nodes.values()) this.regrow(node);
  }

  private regrow(node: Node): void {
    if (node.stock > 0 || node.regrowAt === null || this.now() < node.regrowAt) return;
    node.stock = node.max;
    node.regrowAt = null;
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

  /** How many of `material` character `holder` has. */
  countOf(holder: number, material: string): number {
    return this.pouchOf(holder).get(material) ?? 0;
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
