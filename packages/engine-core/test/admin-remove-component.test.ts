/**
 * Component removal (viewport authoring): the admin `removecomponent`
 * write path — a component an entity has is taken off it, through the
 * live ECS, and `inspect` stops printing it. The inverse of
 * `addcomponent`; the authoring layer's unbind (flow, emitters) rides
 * it. God / Noclip refuse: their dedicated toggle commands own them.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent, hasComponent } from "bitecs";
import * as C from "../src/components.js";
import { SimWorld } from "../src/world.js";
import { ADDABLE_COMPONENTS, applyAddComponent } from "../src/admin/add-component.js";
import { REMOVABLE_COMPONENTS, applyRemoveComponent } from "../src/admin/remove-component.js";
import { inspectEntity } from "../src/admin/inspect.js";

function world(): { sim: SimWorld; bare(): { eid: number; wire: bigint } } {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  sim.beginTick(1);
  return {
    sim,
    bare() {
      const eid = sim.spawn();
      return { eid, wire: sim.wireId(eid) };
    },
  };
}

describe("admin remove-component: applyRemoveComponent", () => {
  it("removes a present component from the live world", () => {
    const { sim, bare } = world();
    const { eid, wire } = bare();
    assert.equal(applyAddComponent(sim, wire, "Health").ok, true);
    assert.equal(hasComponent(sim.ecs, C.Health, eid), true);
    const r = applyRemoveComponent(sim, wire, "Health");
    assert.equal(r.ok, true);
    assert.match(r.message, /Health removed/);
    assert.equal(hasComponent(sim.ecs, C.Health, eid), false);
  });

  it("the removed component is gone from inspect output", () => {
    const { sim, bare } = world();
    const { wire } = bare();
    assert.equal(applyAddComponent(sim, wire, "FlowRef").ok, true);
    assert.match(inspectEntity(sim, wire) ?? "", /FlowRef: graph 0 enabled 1/);
    assert.equal(applyRemoveComponent(sim, wire, "FlowRef").ok, true);
    const dump = inspectEntity(sim, wire);
    assert.ok(dump);
    assert.doesNotMatch(dump, /FlowRef/);
  });

  it("removing a component the entity lacks refuses, and changes nothing", () => {
    const { sim, bare } = world();
    const { eid, wire } = bare();
    assert.equal(applyAddComponent(sim, wire, "Health").ok, true);
    C.Health.current[eid] = 37;
    const r = applyRemoveComponent(sim, wire, "Stamina");
    assert.equal(r.ok, false);
    assert.match(r.message, /has no Stamina/);
    // The refused removal touched nothing else.
    assert.equal(hasComponent(sim.ecs, C.Health, eid), true);
    assert.equal(C.Health.current[eid], 37);
  });

  it("an unknown component name refuses as unknown", () => {
    const { sim, bare } = world();
    const { wire } = bare();
    const r = applyRemoveComponent(sim, wire, "Nope");
    assert.equal(r.ok, false);
    assert.match(r.message, /unknown component/);
  });

  it("an unknown entity refuses as unknown", () => {
    const { sim } = world();
    const r = applyRemoveComponent(sim, 999999999999n, "Health");
    assert.equal(r.ok, false);
    assert.match(r.message, /unknown entity/);
  });

  it("God and Noclip refuse, naming their toggle commands", () => {
    const { sim, bare } = world();
    const { eid, wire } = bare();
    addComponent(sim.ecs, C.God, eid);
    addComponent(sim.ecs, C.Noclip, eid);
    const god = applyRemoveComponent(sim, wire, "God");
    assert.equal(god.ok, false);
    assert.match(god.message, /"god" toggle command/);
    assert.equal(hasComponent(sim.ecs, C.God, eid), true);
    const noclip = applyRemoveComponent(sim, wire, "Noclip");
    assert.equal(noclip.ok, false);
    assert.match(noclip.message, /"noclip" toggle command/);
    assert.equal(hasComponent(sim.ecs, C.Noclip, eid), true);
  });

  it("every addable component is removable (the unbind covers every shelf add)", () => {
    const { sim, bare } = world();
    for (const name of ADDABLE_COMPONENTS) {
      assert.ok(REMOVABLE_COMPONENTS.includes(name), name);
      const { wire } = bare();
      assert.equal(applyAddComponent(sim, wire, name).ok, true, `add ${name}`);
      const r = applyRemoveComponent(sim, wire, name);
      assert.equal(r.ok, true, `remove ${name}: ${r.message}`);
    }
  });

  it("a component removed and re-added starts at its defaults, not its pre-removal values", () => {
    const { sim, bare } = world();
    const { eid, wire } = bare();
    assert.equal(applyAddComponent(sim, wire, "Health").ok, true);
    C.Health.current[eid] = 37;
    assert.equal(applyRemoveComponent(sim, wire, "Health").ok, true);
    assert.equal(applyAddComponent(sim, wire, "Health").ok, true);
    assert.equal(C.Health.current[eid], 100);
  });
});
