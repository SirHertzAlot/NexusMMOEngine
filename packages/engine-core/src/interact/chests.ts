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
}

export type ChestResult = { ok: true; items: number } | { ok: false; error: string };
export type ChestCheck = { ok: true; castSeconds: number; spell: string } | { ok: false; error: string };

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
    this.chests.set(eid, { ...spec, eid, key, refillAt: null, doorOpen: false, body: null });
  }

  has(eid: number): boolean {
    return this.chests.has(eid);
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
      return { ok: true, items: 0 };
    }
    c.refillAt = this.now() + (c.refillSeconds ?? 600) * 1000;
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
    for (const c of this.chests.values()) {
      if (c.refillAt !== null && now >= c.refillAt) {
        c.refillAt = null;
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
