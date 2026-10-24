/**
 * BreakSystem (IX4): props that break. An archetype with `breakable` spawns with
 * Health and the Breakable tag (scatter-spawn); combat already hurts anything with
 * Health, and DeathSystem skips the tag, so at zero it is this system's turn:
 *
 * - "remove": the entity goes.
 * - "variant": it stays, broken: its AssetRef variant becomes BROKEN_VARIANT (the
 *   client draws it tipped and dark), its collider and health go, and it is no longer
 *   breakable.
 * - "debris": it goes and the `debris` archetype stands in its place.
 *
 * In every case the archetype's `loot` table is rolled at the spot for whoever dealt the
 * last blow. Respawn (`respawnS`) and persistence are IX5's.
 */

import { defineQuery, removeComponent } from "bitecs";
import { fnv1a32 } from "@mmo-engine/scatter";
import type { Breakable as BreakableDef, SpawnTable } from "@mmo-engine/scatter";
import { BROKEN_VARIANT } from "@mmo-engine/protocol";
import { AssetRef, BodyConfig, Breakable, Health, Transform } from "../components.js";
import type { SimWorld } from "../world.js";
import type { SimSystem } from "../systems.js";

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
  /** A prop broke: roll its loot, count it, tell the run. Called before the entity changes. */
  onBreak?: (sim: SimWorld, ev: BreakEvent) => void;
  /** Stand the `debris` archetype where a prop was. */
  spawnDebris?: (sim: SimWorld, debris: string, x: number, y: number, z: number, yaw: number) => void;
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

export class BreakSystem implements SimSystem {
  readonly name = "breaks";
  private readonly bodies = defineQuery([Transform, Health, Breakable]);
  /** Props broken so far (a run's or the world's tally). */
  broken = 0;

  constructor(
    private readonly defs: ReadonlyMap<number, BreakableDef>,
    private readonly opts: BreakSystemOptions = {},
  ) {}

  step(sim: SimWorld): void {
    for (const eid of this.bodies(sim.ecs)) {
      if (Health.current[eid]! > 0) continue;
      const def = this.defs.get(AssetRef.assetHash[eid]! >>> 0);
      if (!def) {
        removeComponent(sim.ecs, Breakable, eid); // no data for it: leave it be
        continue;
      }
      this.breakIt(sim, eid, def);
    }
  }

  private breakIt(sim: SimWorld, eid: number, def: BreakableDef): void {
    const x = Transform.px[eid]!;
    const y = Transform.py[eid]!;
    const z = Transform.pz[eid]!;
    const qy = Transform.qy[eid]!;
    const qw = Transform.qw[eid]!;
    this.broken++;
    this.opts.onBreak?.(sim, { eid, x, z, ...(def.loot !== undefined ? { loot: def.loot } : {}), killer: this.opts.killerOf?.(eid) });
    if (def.into === "variant") {
      AssetRef.variant[eid] = BROKEN_VARIANT;
      removeComponent(sim.ecs, BodyConfig, eid);
      removeComponent(sim.ecs, Health, eid);
      removeComponent(sim.ecs, Breakable, eid);
      return;
    }
    sim.despawn(eid);
    if (def.into === "debris" && def.debris) this.opts.spawnDebris?.(sim, def.debris, x, y, z, 2 * Math.atan2(qy, qw));
  }
}
