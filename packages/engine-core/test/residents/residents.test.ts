/**
 * Residents (R1): the baked people stand where their schedule puts them: outdoors at their own
 * structure by day, nobody but the homeless about at night, the same looks on every boot, and the
 * region budget respected.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { entityExists } from "bitecs";
import { Appearance, Transform } from "../../src/components.js";
import { SimWorld } from "../../src/world.js";
import { ResidentSystem, type ResidentNpc, type ResidentTown } from "../../src/residents/index.js";

// The real schedule, from the settlement package (engine-core does not depend on it; the module that wires residents does).
const settlementPath = "../../../../settlement/dist/src/index.js";
const settlement = (await import(settlementPath)) as {
  SQUARE: string;
  scheduleAt(npc: unknown, timeOfDay: number, town: { archetypeOf(s: string): string | undefined; tavernNear(h: string | null): string | undefined }): { anchor: string; outdoors: boolean; activity: string };
};

const ARCH: Record<string, string> = { h0: "house", h1: "house", b1: "bakery", c1: "chapel", t1: "tavern" };
const POS: Record<string, { x: number; z: number }> = { h0: { x: 0, z: 0 }, h1: { x: 20, z: 0 }, b1: { x: 40, z: 0 }, c1: { x: 60, z: 0 }, t1: { x: 80, z: 0 }, [settlement.SQUARE]: { x: 100, z: 100 } };
const view = { archetypeOf: (s: string) => ARCH[s], tavernNear: () => "t1" };

function npcs(n: number): Array<ResidentNpc & { cohort: string; workplace?: string; household: string | null }> {
  return Array.from({ length: n }, (_, i) => ({
    id: `npc_${i}`,
    household: "hh",
    home: i % 2 ? "h1" : "h0",
    cohort: i % 5 === 0 ? "child" : "adult",
    class: "peasant",
    role: i % 3 === 0 ? "worker" : "resident",
    ...(i % 3 === 0 && i % 5 !== 0 ? { workplace: "b1" } : {}),
  }));
}

function town(n = 60): ResidentTown {
  return { id: "t", npcs: npcs(n), positionOf: (a) => POS[a] };
}

function system(opts: { hour: () => number; towns?: ResidentTown[]; maxEntities?: number }): ResidentSystem {
  return new ResidentSystem({
    towns: opts.towns ?? [town()],
    place: (_t, npc, tod) => settlement.scheduleAt(npc, tod, view),
    timeOfDay: opts.hour,
    catalog: null,
    maxEntities: opts.maxEntities,
  });
}

function run(sys: ResidentSystem, sim: SimWorld, tick: number): void {
  sim.beginTick(tick);
  sys.step(sim);
}

describe("ResidentSystem", () => {
  it("stands the outdoor residents at their anchors by day, on their own structure", () => {
    let hour = 12 / 24;
    const sim = new SimWorld();
    const sys = system({ hour: () => hour });
    run(sys, sim, 30);
    assert.ok(sys.count > 0);
    const t = town();
    for (const n of t.npcs) {
      const eid = sys.entityOf(n.id);
      if (eid === undefined) continue;
      const want = settlement.scheduleAt(n, hour, view).anchor;
      const pos = POS[want]!;
      const d = Math.hypot(Transform.px[eid]! - pos.x, Transform.pz[eid]! - pos.z);
      assert.ok(d <= 13, `${n.id} within the anchor's spread (${d.toFixed(1)} m of ${want})`);
      assert.equal(sys.describe(eid)?.npc, n.id);
    }
  });

  it("empties the town at night (nobody outdoors but the homeless) and refills it by day", () => {
    let hour = 12 / 24;
    const sim = new SimWorld();
    const sys = system({ hour: () => hour });
    run(sys, sim, 30);
    const byDay = sys.count;
    hour = 2 / 24;
    run(sys, sim, 60);
    assert.equal(sys.count, 0, "everyone has a home");
    hour = 12 / 24;
    run(sys, sim, 90);
    assert.equal(sys.count, byDay);
  });

  it("looks and places are the same on every boot", () => {
    const snapshot = (): string => {
      const sim = new SimWorld();
      const sys = system({ hour: () => 0.5 });
      run(sys, sim, 30);
      return town().npcs.map((n) => {
        const e = sys.entityOf(n.id);
        return e === undefined ? "-" : `${sim.lookJson(Appearance.look[e]!)}${Transform.px[e]!.toFixed(3)},${Transform.pz[e]!.toFixed(3)}`;
      }).join("|");
    };
    assert.equal(snapshot(), snapshot());
  });

  it("never exceeds the region budget", () => {
    const sim = new SimWorld();
    const sys = system({ hour: () => 0.5, maxEntities: 7 });
    run(sys, sim, 30);
    assert.equal(sys.count, 7);
    for (const n of town().npcs) {
      const e = sys.entityOf(n.id);
      if (e !== undefined) assert.equal(entityExists(sim.ecs, e), true);
    }
  });

  it("only runs once a second", () => {
    const sim = new SimWorld();
    let calls = 0;
    const sys = new ResidentSystem({ towns: [town(3)], place: (_t, n, tod) => (calls++, settlement.scheduleAt(n, tod, view)), catalog: null });
    run(sys, sim, 30);
    const first = calls;
    run(sys, sim, 31);
    run(sys, sim, 45);
    assert.equal(calls, first);
    run(sys, sim, 60);
    assert.equal(calls, first * 2);
  });
});
