/**
 * World chests (IX1): a chest is a scene Structure with a `Chest` component
 * (`table`, `refillSeconds`). It is shared: the first player to open it gets
 * the table's items on the ground at the chest, owned by them for the loot
 * rules' ownership time; it is empty until its refill timer comes due, then
 * full for whoever comes next. State lives in memory (a restart refills every
 * chest; persistence is IX5's place record).
 */

import { z } from "zod";
import { Transform } from "../components.js";
import type { SimWorld } from "../world.js";
import type { SimSystem } from "../systems.js";
import type { ChestView } from "@mmo-engine/protocol";

/** An interact request (catalog 0x27): an entity's wire id, or a quest giver's or dungeon entrance's content id. */
const contentId = z.string().min(1).max(64);
export const InteractActionSchema = z.union([
  z.object({ kind: z.literal("interact"), entity: z.string().regex(/^\d{1,20}$/) }).strict(),
  z.object({ kind: z.literal("interact"), npc: contentId }).strict(),
  z.object({ kind: z.literal("interact"), entrance: contentId }).strict(),
]);

export interface ChestSpec {
  /** A loot.json table the chest rolls when opened. */
  table: string;
  /** Seconds until an opened chest is full again. */
  refillSeconds: number;
}

export interface ChestSystemOptions {
  /** Put the table's items on the ground at (x, z), owned by `owner`; returns how many. */
  drop: (sim: SimWorld, table: string, x: number, z: number, owner: number) => number;
  /** How close a player must be to the chest's centre, metres. Default 3. */
  reachM?: number;
  now?: () => number;
}

interface Chest extends ChestSpec {
  eid: number;
  key: string;
  /** When it is full again; null: full now. */
  refillAt: number | null;
}

export type ChestResult = { ok: true; items: number } | { ok: false; error: string };

export class ChestSystem implements SimSystem {
  readonly name = "chests";
  private readonly chests = new Map<number, Chest>();
  private changed = new Set<Chest>();
  private readonly reachM: number;
  private readonly now: () => number;

  constructor(private readonly opts: ChestSystemOptions) {
    this.reachM = opts.reachM ?? 3;
    this.now = opts.now ?? Date.now;
  }

  register(eid: number, key: string, spec: ChestSpec): void {
    this.chests.set(eid, { ...spec, eid, key, refillAt: null });
  }

  has(eid: number): boolean {
    return this.chests.has(eid);
  }

  get size(): number {
    return this.chests.size;
  }

  /** Open chest `eid` as character `holder` whose avatar is entity `avatar`. */
  open(sim: SimWorld, holder: number, avatar: number, eid: number): ChestResult {
    const c = eid < 0 ? undefined : this.chests.get(eid);
    if (!c) return { ok: false, error: "nothing to open there" };
    const dx = Transform.px[eid]! - Transform.px[avatar]!;
    const dz = Transform.pz[eid]! - Transform.pz[avatar]!;
    if (dx * dx + dz * dz > this.reachM * this.reachM) return { ok: false, error: "too far away" };
    if (c.refillAt !== null) return { ok: false, error: "the chest is empty" };
    c.refillAt = this.now() + c.refillSeconds * 1000;
    this.changed.add(c);
    return { ok: true, items: this.opts.drop(sim, c.table, Transform.px[eid]!, Transform.pz[eid]!, holder > 0 ? holder : 0) };
  }

  /** Chests whose timer has come due are full again. */
  step(): void {
    const now = this.now();
    for (const c of this.chests.values()) {
      if (c.refillAt !== null && now >= c.refillAt) {
        c.refillAt = null;
        this.changed.add(c);
      }
    }
  }

  private view(sim: SimWorld, c: Chest): ChestView {
    return { entity: String(sim.wireId(c.eid)), x: Transform.px[c.eid]!, z: Transform.pz[c.eid]!, open: c.refillAt !== null };
  }

  views(sim: SimWorld): ChestView[] {
    return [...this.chests.values()].map((c) => this.view(sim, c));
  }

  /** The chests that changed since the last drain. */
  drainChanges(sim: SimWorld): ChestView[] {
    if (this.changed.size === 0) return [];
    const out = [...this.changed].map((c) => this.view(sim, c));
    this.changed = new Set();
    return out;
  }
}
