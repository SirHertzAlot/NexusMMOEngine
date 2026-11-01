/**
 * Residents (R1): the baked people stand where their schedule puts them: outdoors at their own
 * structure by day, nobody but the homeless about at night, the same looks on every boot, and the
 * region budget respected.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { entityExists } from "bitecs";
import Database from "better-sqlite3";
import { addComponent } from "bitecs";
import { Appearance, CharacterRef, Health, NavAgent, NavAgentState, Transform } from "../../src/components.js";
import { SqlitePlacesStore } from "../../src/interact/index.js";
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

describe("ResidentSystem: walking", () => {
  const baker = (): ResidentTown => ({
    id: "t",
    npcs: [{ id: "npc_3", home: "h0", role: "worker", class: "artisan", cohort: "adult", workplace: "b1" } as ResidentNpc],
    positionOf: (a) => POS[a],
  });
  function make(hour: { v: number }): ResidentSystem {
    return new ResidentSystem({ towns: [baker()], place: (_t, npc, tod) => settlement.scheduleAt(npc, tod, view), timeOfDay: () => hour.v, catalog: null, steer: true });
  }

  it("comes out of the home it was in, walks to work through the crowd, and stands on arrival", () => {
    const hour = { v: 3 / 24 };
    const sim = new SimWorld();
    const sys = make(hour);
    run(sys, sim, 30);
    assert.equal(sys.count, 0, "asleep indoors");

    hour.v = 12 / 24;
    run(sys, sim, 60);
    const e = sys.entityOf("npc_3")!;
    assert.ok(Math.hypot(Transform.px[e]! - POS.h0!.x, Transform.pz[e]! - POS.h0!.z) < 6, "starts at the door of home");
    NavAgent.state[e] = NavAgentState.Idle; // the crowd has taken the new agent
    run(sys, sim, 90);
    assert.ok(Math.hypot(NavAgent.tx[e]! - POS.b1!.x, NavAgent.tz[e]! - POS.b1!.z) < 6, "the crowd is told to go to the bakery");

    // They get there: the next pass has them stand.
    Transform.px[e] = NavAgent.tx[e]!;
    Transform.pz[e] = NavAgent.tz[e]!;
    run(sys, sim, 120);
    assert.ok(Number.isNaN(NavAgent.tx[e]!), "standing at work");
  });

  it("walks to the door at day's end and is gone on arrival", () => {
    const hour = { v: 12 / 24 };
    const sim = new SimWorld();
    const sys = make(hour);
    run(sys, sim, 30);
    const e = sys.entityOf("npc_3")!;
    NavAgent.state[e] = NavAgentState.Idle;
    hour.v = 23 / 24;
    run(sys, sim, 60);
    assert.equal(sys.entityOf("npc_3"), e, "still on the street, headed home");
    run(sys, sim, 90); // the target is given
    assert.ok(Math.hypot(NavAgent.tx[e]! - POS.h0!.x, NavAgent.tz[e]! - POS.h0!.z) < 6);
    Transform.px[e] = NavAgent.tx[e]!;
    Transform.pz[e] = NavAgent.tz[e]!;
    run(sys, sim, 120);
    assert.equal(sys.entityOf("npc_3"), undefined, "indoors");
    assert.equal(sys.count, 0);
  });
});

describe("ResidentSystem: tiers", () => {
  const far = (n = 6): ResidentTown => ({ ...town(n), centre: { x: 40, z: 0 }, radius: 50 });
  function player(sim: SimWorld, x: number): number {
    const e = sim.spawn();
    addComponent(sim.ecs, Transform, e);
    addComponent(sim.ecs, CharacterRef, e);
    Transform.px[e] = x;
    Transform.pz[e] = 0;
    return e;
  }
  function make(extra: { maxFull?: number } = {}): ResidentSystem {
    return new ResidentSystem({ towns: [far(12)], place: (_t, npc, tod) => settlement.scheduleAt(npc, tod, view), timeOfDay: () => 0.5, catalog: null, steer: true, fullM: 150, coarseM: 400, ...extra });
  }

  it("has nobody where no player is near, places them when one comes, and walks them only close up", () => {
    const sim = new SimWorld();
    const sys = make();
    const p = player(sim, 1000); // 910 m from the town's edge
    run(sys, sim, 30);
    assert.deepEqual([sys.tierOf("t"), sys.count], ["none", 0]);
    Transform.px[p] = 40 + 50 + 300; // coarse: 300 m from the edge
    run(sys, sim, 60);
    assert.equal(sys.tierOf("t"), "coarse");
    assert.ok(sys.count > 0);
    assert.equal(sys.walking, 0, "no crowd slots");
    Transform.px[p] = 40 + 50 + 100; // full
    run(sys, sim, 90);
    assert.equal(sys.tierOf("t"), "full");
  });

  it("holds a tier for 25 m past its edge", () => {
    const sim = new SimWorld();
    const sys = make();
    const p = player(sim, 40 + 50 + 100);
    run(sys, sim, 30);
    assert.equal(sys.tierOf("t"), "full");
    Transform.px[p] = 40 + 50 + 160; // 10 m past the full edge: still full
    run(sys, sim, 60);
    assert.equal(sys.tierOf("t"), "full");
    Transform.px[p] = 40 + 50 + 200;
    run(sys, sim, 90);
    assert.equal(sys.tierOf("t"), "coarse");
  });

  it("gives crowd slots only up to maxFull and frees them when the town goes coarse", () => {
    const sim = new SimWorld();
    const sys = make({ maxFull: 3 });
    const p = player(sim, 40 + 50 + 100);
    run(sys, sim, 30);
    assert.ok(sys.count > 3);
    assert.equal(sys.walking, 3);
    Transform.px[p] = 40 + 50 + 300;
    run(sys, sim, 60);
    assert.equal(sys.walking, 0);
  });
});

describe("ResidentSystem: attackable", () => {
  const one = (): ResidentTown => ({
    id: "t",
    npcs: [{ id: "npc_9", home: null, role: "resident", class: "peasant", cohort: "adult" } as ResidentNpc],
    positionOf: () => ({ x: 10, z: 10 }),
  });
  function make(clock: { t: number }, store?: SqlitePlacesStore): ResidentSystem {
    return new ResidentSystem({
      towns: [one()],
      place: () => ({ anchor: "sq", outdoors: true, activity: "idle" }),
      catalog: null,
      store,
      now: () => clock.t,
      replaceMs: 1000,
      corpseSeconds: 2,
    });
  }

  it("a fallen resident lies a while, is gone, and stays dead until someone new moves in with a new look", () => {
    const clock = { t: 1_000_000 };
    const sim = new SimWorld();
    const sys = make(clock);
    run(sys, sim, 30);
    const eid = sys.entityOf("npc_9")!;
    assert.equal(sys.isResident(eid), true);
    const firstLook = sim.lookJson(Appearance.look[eid]!);
    Health.current[eid] = 0;
    run(sys, sim, 60);
    assert.equal(sys.entityOf("npc_9"), eid, "the body lies there");
    run(sys, sim, 120); // past two seconds of corpse
    assert.equal(sys.entityOf("npc_9"), undefined);
    run(sys, sim, 150);
    assert.equal(sys.count, 0, "stays dead");
    clock.t += 1500;
    run(sys, sim, 180);
    const again = sys.entityOf("npc_9")!;
    assert.ok(again !== undefined, "someone new moved in");
    assert.equal(sys.generationOf("npc_9"), 1);
    assert.notEqual(sim.lookJson(Appearance.look[again]!), firstLook, "a new face");
  });

  it("a shopkeeper's shop opens while they stand there and shuts when they fall", () => {
    const sim = new SimWorld();
    const bound = new Map<number, string>();
    const sys = new ResidentSystem({
      towns: [{ ...town(), keeps: new Map([["npc_3", "bakery"]]) }],
      place: (_t, npc, tod) => settlement.scheduleAt(npc, tod, view),
      timeOfDay: () => 0.45,
      catalog: null,
      attachShop: (eid, archetype) => void bound.set(eid, archetype),
      detachShop: (eid) => void bound.delete(eid),
    });
    run(sys, sim, 30);
    const eid = sys.entityOf("npc_3")!;
    assert.equal(bound.get(eid), "bakery");
    assert.equal(bound.size, 1, "only the keeper");
    Health.current[eid] = 0;
    run(sys, sim, 60);
    assert.equal(bound.size, 0, "closed once they fall");
  });

  it("summarises each town for the debugger", () => {
    const sim = new SimWorld();
    const sys = system({ hour: () => 0.45 });
    run(sys, sim, 30);
    const s = sys.summary();
    assert.equal(s.towns.length, 1);
    assert.equal(s.towns[0]!.id, "t");
    assert.equal(s.towns[0]!.people, 60);
    assert.equal(s.towns[0]!.live, sys.count);
    assert.equal(s.live, sys.count);
    assert.ok(s.live > 0, "some stand outdoors by day");
  });

  it("a death survives a restart", () => {
    const store = new SqlitePlacesStore(new Database(":memory:"));
    const clock = { t: 5_000_000 };
    const sim1 = new SimWorld();
    const a = make(clock, store);
    run(a, sim1, 30);
    Health.current[a.entityOf("npc_9")!] = 0;
    run(a, sim1, 60);
    assert.equal(store.load("resident", "npc_9")?.state, "dead:0");

    const sim2 = new SimWorld();
    const b = make(clock, store);
    run(b, sim2, 30);
    assert.equal(b.count, 0, "still dead after the restart");
    clock.t += 2000;
    run(b, sim2, 60);
    assert.equal(b.count, 1, "replaced on schedule");
    assert.equal(store.load("resident", "npc_9")?.state, "alive:1");
  });
});

describe("ResidentSystem: raids", () => {
  const people: ResidentNpc[] = [
    { id: "npc_a", home: "h0", role: "baker", class: "artisan", cohort: "adult" },
    { id: "npc_b", home: "h1", role: "resident", class: "peasant", cohort: "adult" },
    { id: "npc_g", home: "h1", role: "town guard", class: "guard", cohort: "adult" },
  ];
  const t: ResidentTown = { id: "t", npcs: people, positionOf: (a) => POS[a] ?? POS.h0, centre: { x: 40, z: 0 }, radius: 50 };

  /** A player in the town, so it is simulated. */
  const near = (sim: SimWorld): void => {
    const e = sim.spawn();
    addComponent(sim.ecs, Transform, e);
    addComponent(sim.ecs, CharacterRef, e);
    Transform.px[e] = 40;
  };

  it("everyone outdoors but the guard takes cover while raiders are there, and they come out again after a pause", () => {
    let raid = false;
    const sim = new SimWorld();
    near(sim);
    const sys = new ResidentSystem({
      towns: [t],
      place: () => ({ anchor: "sq", outdoors: true, activity: "idle" }),
      raided: () => (raid ? [{ x: 60, z: 0, radius: 20 }] : []),
      bark: (_t, _n, c) => (c.raid ? "Raiders!" : "Hello"),
      catalog: null,
    });
    run(sys, sim, 30);
    assert.equal(sys.count, 3);
    raid = true;
    run(sys, sim, 60);
    assert.deepEqual([sys.count, sys.entityOf("npc_g") !== undefined, sys.underRaid("t")], [1, true, true], "only the guard holds");
    assert.equal(sys.talk(sys.entityOf("npc_g")!, 60)?.text, "Raiders!");
    raid = false;
    run(sys, sim, 90);
    assert.equal(sys.count, 1, "still in cover just after");
    run(sys, sim, 90 + 30 * 70); // past the longest pause
    assert.equal(sys.count, 3, "carrying on again");
    assert.equal(sys.underRaid("t"), false);
  });

  it("a town far from the raiders is left alone", () => {
    const sim = new SimWorld();
    near(sim);
    const sys = new ResidentSystem({ towns: [t], place: () => ({ anchor: "sq", outdoors: true, activity: "idle" }), raided: () => [{ x: 5000, z: 5000, radius: 30 }], catalog: null });
    run(sys, sim, 30);
    assert.equal(sys.count, 3);
  });
});

describe("ResidentSystem: talk", () => {
  it("answers with the bark for the resident's town and npc, at the game's hour and day, and names them by role", () => {
    const seen: Array<{ npc: string; tod: number; day: number; raid: boolean }> = [];
    const sim = new SimWorld();
    const sys = new ResidentSystem({
      towns: [town()],
      place: (_t, npc, tod) => settlement.scheduleAt(npc, tod, view),
      timeOfDay: () => 12 / 24,
      dayOf: () => 7,
      bark: (_t, npc, c) => (seen.push({ npc: npc.id, tod: c.timeOfDay, day: c.day, raid: c.raid ?? false }), `Hi from ${npc.id}`),
      catalog: null,
    });
    run(sys, sim, 30);
    const eid = town().npcs.map((n) => sys.entityOf(n.id)).find((e): e is number => e !== undefined);
    assert.ok(eid !== undefined, "someone is out by day");
    const said = sys.talk(eid, 30);
    assert.ok(said);
    assert.equal(said.text, `Hi from ${said.npc}`);
    assert.equal(said.name, said.name.charAt(0).toUpperCase() + said.name.slice(1), "name is capitalised");
    assert.deepEqual(seen.at(-1), { npc: said.npc, tod: 12 / 24, day: 7, raid: false });
  });

  it("is undefined for anything that is not a resident, and says '...' when no bark is wired", () => {
    const sim = new SimWorld();
    const sys = system({ hour: () => 12 / 24 });
    run(sys, sim, 30);
    const stranger = sim.spawn();
    assert.equal(sys.talk(stranger, 30), undefined);
    const eid = town().npcs.map((n) => sys.entityOf(n.id)).find((e): e is number => e !== undefined)!;
    assert.equal(sys.talk(eid, 30)?.text, "...");
  });
});
