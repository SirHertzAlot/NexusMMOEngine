/**
 * Admin search and the widened `set` (roadmap A2): `find` matches an
 * entity by wire-id prefix, component name or creature name and caps its
 * list; `set` writes Needs fields and stat bases (the `Stat`
 * pseudo-component) and refuses what it cannot write.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/components.js";
import { SimWorld } from "../src/world.js";
import { findEntities, FIND_LIMIT } from "../src/admin/find.js";
import { applySet } from "../src/admin/set.js";
import { loadGameRules } from "../src/rules/boot.js";
import { addComponent } from "bitecs";

const { rules } = loadGameRules();

function world(withStats: boolean): SimWorld {
  SimWorld.resetEntityCursorForTesting();
  const sim = withStats ? new SimWorld({ stats: rules.stats }) : new SimWorld();
  sim.beginTick(1);
  return sim;
}

function positioned(sim: SimWorld, x: number, z: number): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, C.Transform, eid);
  C.Transform.px[eid] = x;
  C.Transform.py[eid] = 0;
  C.Transform.pz[eid] = z;
  return eid;
}

describe("admin find", () => {
  it("matches by wire-id prefix, by component name (any case), and by creature name", () => {
    const sim = world(false);
    const a = positioned(sim, 0, 0);
    const b = positioned(sim, 1, 0);
    addComponent(sim.ecs, C.Health, b);
    const wolf = positioned(sim, 2, 0);
    const names = new Map([[wolf, "Grey Wolf"]]);
    const nameOf = (e: number) => names.get(e);

    const byId = findEntities(sim, sim.wireId(a).toString(), nameOf);
    assert.ok(byId.lines.some((l) => l.startsWith(sim.wireId(a).toString())));

    const byComp = findEntities(sim, "health", nameOf);
    assert.equal(byComp.total, 1);
    assert.ok(byComp.lines[0]!.startsWith(sim.wireId(b).toString()));

    const byCreature = findEntities(sim, "WOLF", nameOf);
    assert.equal(byCreature.total, 1);
    assert.equal(byCreature.lines[0], `${sim.wireId(wolf)} Grey Wolf`);
  });

  it("reports zero matches as zero, and caps the list while counting every match", () => {
    const sim = world(false);
    for (let i = 0; i < FIND_LIMIT + 5; i++) positioned(sim, i, 0);
    assert.equal(findEntities(sim, "no-such-thing").total, 0);
    const all = findEntities(sim, "transform");
    assert.equal(all.total, FIND_LIMIT + 5);
    assert.equal(all.lines.length, FIND_LIMIT);
  });
});

describe("admin set: the widened fields", () => {
  it("writes Needs fields, and refuses a non-finite value", () => {
    const sim = world(false);
    const eid = positioned(sim, 0, 0);
    addComponent(sim.ecs, C.Needs, eid);
    const wire = sim.wireId(eid);
    const ok = applySet(sim, wire, "Needs", "hunger", 42.5);
    assert.equal(ok.ok, true, ok.message);
    assert.equal(C.Needs.hunger[eid], 42.5);
    const bad = applySet(sim, wire, "Needs", "hunger", Number.NaN);
    assert.equal(bad.ok, false);
    assert.equal(C.Needs.hunger[eid], 42.5);
  });

  it("writes a stat base through Stat when the entity has a sheet, and refuses otherwise", () => {
    const sim = world(true);
    const eid = positioned(sim, 0, 0);
    const wire = sim.wireId(eid);
    const statId = rules.stats.attributes[0]!.id;

    const none = applySet(sim, wire, "Stat", statId, 50);
    assert.equal(none.ok, false);
    assert.match(none.message, /has no Stat/);

    sim.stats.attach(eid, {});
    const ok = applySet(sim, wire, "Stat", statId, 50);
    assert.equal(ok.ok, true, ok.message);
    assert.equal(sim.stats.base(eid, statId), 50);

    const unknown = applySet(sim, wire, "Stat", "not-a-stat", 1);
    assert.equal(unknown.ok, false);
    assert.match(unknown.message, /unknown stat/);
  });
});
