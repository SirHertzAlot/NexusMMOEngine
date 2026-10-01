/**
 * Item definitions (roadmap M3a): every item the world can hold, from the
 * baked loot pool (docs/DUNGEONS-AND-LOOT.md §6) joined with the rules'
 * physics per item base (content/rules/items.json).
 *
 * A definition is static for the server's life. Its name, rank and stats
 * are strings and maps (read when an item is shown or dropped); what the
 * combat path reads per blow — mass, reach, edge, point, hardness,
 * balance, power, hand — sits in flat typed columns indexed by definition,
 * so a strike reads numbers, never objects.
 */

import { readFileSync } from "node:fs";
import type { ItemHand } from "@mmo-engine/protocol";
import type { ItemBaseRules, Rules } from "@mmo-engine/rules";
import { fnv1a32 } from "@mmo-engine/scatter";

/** One composed item, as the loot pool stores it (`pool.jsonl` lines). */
export interface PoolItemLike {
  id: string;
  rank: string;
  source: string;
  item: string;
  seed: number;
  bundle: {
    Identity: { id: string; name: string; base: string };
    Rank: { id: string; color: string };
    Stats: Record<string, number>;
  };
}

export const HAND_CODE: Record<ItemHand, number> = { none: 0, main: 1, off: 2, both: 3 };
export const HAND_NAME: readonly ItemHand[] = ["none", "main", "off", "both"];

export class ItemDefs {
  readonly count: number;
  readonly ids: readonly string[];
  readonly names: readonly string[];
  readonly bases: readonly string[];
  readonly ranks: readonly string[];
  readonly colors: readonly string[];
  readonly sources: readonly string[];
  readonly stats: ReadonlyArray<Readonly<Record<string, number>>>;
  /** Art catalog model id, "" when the base has none. */
  readonly models: readonly string[];
  /** fnv1a32 of the model id (AssetRef.assetHash), 0 when none. */
  readonly assetHash: Uint32Array;
  readonly mass: Float32Array;
  readonly length: Float32Array;
  readonly edge: Float32Array;
  readonly point: Float32Array;
  readonly hardness: Float32Array;
  readonly balance: Float32Array;
  readonly durability: Float32Array;
  /** The composed `power` stat. */
  readonly power: Float32Array;
  /** HAND_CODE of the hand it is held in. */
  readonly hand: Uint8Array;
  /** The plain attack's technique id, per definition. */
  readonly technique: readonly string[];
  private readonly byId: Map<string, number>;
  private readonly bySource = new Map<string, number[]>();
  private readonly byBase = new Map<string, number[]>();

  constructor(items: readonly PoolItemLike[], rules: Pick<Rules, "items">) {
    const n = items.length;
    this.count = n;
    const ids: string[] = [];
    const names: string[] = [];
    const bases: string[] = [];
    const ranks: string[] = [];
    const colors: string[] = [];
    const sources: string[] = [];
    const stats: Record<string, number>[] = [];
    const models: string[] = [];
    const technique: string[] = [];
    this.assetHash = new Uint32Array(n);
    this.mass = new Float32Array(n);
    this.length = new Float32Array(n);
    this.edge = new Float32Array(n);
    this.point = new Float32Array(n);
    this.hardness = new Float32Array(n);
    this.balance = new Float32Array(n);
    this.durability = new Float32Array(n);
    this.power = new Float32Array(n);
    this.hand = new Uint8Array(n);
    this.byId = new Map();
    for (let i = 0; i < n; i++) {
      const it = items[i];
      const base = it.bundle.Identity.base || it.item;
      const phys: ItemBaseRules = rules.items.bases[base] ?? rules.items.fallback;
      const model = phys.models.length > 0 ? phys.models[(it.seed >>> 0) % phys.models.length] : "";
      ids.push(it.id);
      names.push(it.bundle.Identity.name);
      bases.push(base);
      ranks.push(it.rank);
      colors.push(it.bundle.Rank.color);
      sources.push(it.source);
      stats.push(it.bundle.Stats);
      models.push(model);
      technique.push(phys.technique);
      this.assetHash[i] = model ? fnv1a32(model) : 0;
      this.mass[i] = phys.mass;
      this.length[i] = phys.length;
      this.edge[i] = phys.edge;
      this.point[i] = phys.point;
      this.hardness[i] = phys.hardness;
      this.balance[i] = phys.balance;
      this.durability[i] = phys.durability;
      this.power[i] = it.bundle.Stats.power ?? 0;
      this.hand[i] = HAND_CODE[phys.hand];
      // Pool ids are unique except for re-rolled commons; the first wins.
      if (!this.byId.has(it.id)) this.byId.set(it.id, i);
      push(this.bySource, it.source, i);
      push(this.byBase, base, i);
    }
    this.ids = ids;
    this.names = names;
    this.bases = bases;
    this.ranks = ranks;
    this.colors = colors;
    this.sources = sources;
    this.stats = stats;
    this.models = models;
    this.technique = technique;
  }

  /** Definition index for a pool id, or -1. */
  indexOf(id: string): number {
    return this.byId.get(id) ?? -1;
  }

  /** Definitions a source (mob, chest, boss, craft) gives, or an empty list. */
  ofSource(source: string): readonly number[] {
    return this.bySource.get(source) ?? EMPTY;
  }

  /** Definitions of one item base (sword, axe, …), or an empty list. */
  ofBase(base: string): readonly number[] {
    return this.byBase.get(base) ?? EMPTY;
  }

  /** The lowest-ranked definition of a base: what a new character starts with. */
  starter(base: string, rankOrder: readonly string[]): number {
    const list = this.ofBase(base);
    let best = -1;
    let bestRank = Infinity;
    for (const i of list) {
      const r = rankOrder.indexOf(this.ranks[i]);
      const k = r < 0 ? rankOrder.length : r;
      if (k < bestRank) {
        bestRank = k;
        best = i;
      }
    }
    return best;
  }
}

const EMPTY: readonly number[] = [];

function push(map: Map<string, number[]>, key: string, value: number): void {
  let list = map.get(key);
  if (!list) map.set(key, (list = []));
  list.push(value);
}

/** Read a baked pool (`pool.jsonl`: one item a line). */
export function readPoolFile(path: string): PoolItemLike[] {
  const text = readFileSync(path, "utf8");
  const out: PoolItemLike[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) out.push(JSON.parse(t) as PoolItemLike);
  }
  return out;
}
