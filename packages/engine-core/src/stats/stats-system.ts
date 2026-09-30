/**
 * StatsSystem — puts the stats the engine keeps in components there. The
 * `maxHealth` drive sets Health.max, and current health keeps its share of
 * the maximum: a buff that raises the maximum raises current health with
 * it, and taking it off lowers both again, so toggling one never heals.
 *
 * Only entities whose stats changed since the last sync are touched. Runs
 * first in the tick, so every later system sees this tick's values.
 * (`moveSpeed` needs no sync: IntentSystem and CharacterSystem read it.)
 */

import { defineQuery } from "bitecs";
import { Health } from "../components.js";
import type { SimSystem } from "../systems.js";
import type { SimWorld } from "../world.js";

export class StatsSystem implements SimSystem {
  readonly name = "stats";
  private readonly query = defineQuery([Health]);
  /** Entity -> the stats version last applied (versions are unique across the book). */
  private readonly synced = new Map<number, number>();

  step(sim: SimWorld, _dtSeconds: number): void {
    if (!sim.stats.layout.drives.has("maxHealth")) return;
    const eids = this.query(sim.ecs);
    if (this.synced.size > eids.length) {
      const live = new Set<number>(eids as unknown as number[]);
      for (const e of this.synced.keys()) if (!live.has(e)) this.synced.delete(e);
    }
    for (let i = 0; i < eids.length; i++) {
      const e = eids[i] as number;
      const version = sim.stats.version(e);
      if (version === 0 || this.synced.get(e) === version) continue;
      this.synced.set(e, version);
      const max = sim.stats.drive(e, "maxHealth")!;
      const old = Health.max[e];
      Health.current[e] = old > 0 ? (Health.current[e] / old) * max : max;
      Health.max[e] = max;
    }
  }
}
