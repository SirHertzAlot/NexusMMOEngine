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
 * broken. A keyed prop (a scene node: `places/P0001`) is saved to the places store when
 * it breaks, and `register` applies the record after a restart, so a break survives it.
 */

import { addComponent, defineQuery, hasComponent, removeComponent } from "bitecs";
import { fnv1a32 } from "@mmo-engine/scatter";
import type { Breakable as BreakableDef, SpawnTable } from "@mmo-engine/scatter";
import { BROKEN_VARIANT } from "@mmo-engine/protocol";
import { AssetRef, BodyConfig, Breakable, Health, Transform, Velocity } from "../components.js";
import type { SimWorld } from "../world.js";
import type { SimSystem } from "../systems.js";
import type { PlacesStore } from "./places-store.js";

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

interface Pending {
  key: string | null;
  def: BreakableDef;
  snap: Snap;
  respawnAt: number;
  /** "variant": the broken entity itself. */
  eid: number | null;
  /** "debris": the debris that stands there meanwhile. */
  debris: number | null;
}

export class BreakSystem implements SimSystem {
  readonly name = "breaks";
  private readonly bodies = defineQuery([Transform, Health, Breakable]);
  private readonly keys = new Map<number, string>();
  private readonly eidDefs = new Map<number, BreakableDef>();
  private pending: Pending[] = [];
  private readonly now: () => number;
  /** Props broken so far (a run's or the world's tally). */
  broken = 0;

  constructor(
    private readonly defs: ReadonlyMap<number, BreakableDef>,
    private readonly opts: BreakSystemOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
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
    const rec = this.opts.store?.load("break", key);
    if (!rec) return;
    if (rec.respawnAt !== null && this.now() >= rec.respawnAt) {
      this.opts.store!.clear("break", key); // it came back while the server was down
      return;
    }
    this.breakIt(sim, eid, def, { at: rec.at, respawnAt: rec.respawnAt });
  }

  step(sim: SimWorld): void {
    this.respawns(sim);
    for (const eid of this.bodies(sim.ecs)) {
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
    const at = again?.at ?? this.now();
    const respawnAt = again ? again.respawnAt : def.respawnS !== null ? at + def.respawnS * 1000 : null;
    this.broken++;
    if (!again) this.opts.onBreak?.(sim, { eid, x, z, ...(def.loot !== undefined ? { loot: def.loot } : {}), killer: this.opts.killerOf?.(eid) });
    if (key !== null) this.opts.store?.save({ kind: "break", key, state: "broken", at, respawnAt });
    const snap = respawnAt !== null ? capture(sim, eid) : null;
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
    if (snap && respawnAt !== null) this.pending.push({ key, def, snap, respawnAt, eid: def.into === "variant" ? eid : null, debris });
  }

  /** Props whose time has come are back. */
  private respawns(sim: SimWorld): void {
    if (this.pending.length === 0) return;
    const now = this.now();
    const later: Pending[] = [];
    for (const p of this.pending) {
      if (now < p.respawnAt) {
        later.push(p);
        continue;
      }
      if (p.debris !== null) sim.despawn(p.debris);
      const eid = p.eid !== null ? p.eid : sim.spawn();
      restore(sim, eid, p.snap, p.eid !== null);
      this.eidDefs.set(eid, p.def);
      if (p.key !== null) {
        this.keys.set(eid, p.key);
        this.opts.store?.clear("break", p.key);
      }
    }
    this.pending = later;
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
