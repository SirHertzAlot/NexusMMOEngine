/**
 * Component addition (viewport authoring): the admin `addcomponent`
 * write path — a component an entity lacks is added with its defaults,
 * through the live ECS, visible to `inspect` afterwards. The addable
 * set is the defaults table in admin/add-component.ts; a drift guard
 * keeps every entry's field set equal to the component's own schema.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasComponent } from "bitecs";
import * as C from "../src/components.js";
import { SimWorld } from "../src/world.js";
import { ADDABLE_COMPONENTS, COMPONENT_DEFAULTS, applyAddComponent } from "../src/admin/add-component.js";
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

describe("admin add-component: the defaults table", () => {
  it("every addable entry defaults exactly the component's own fields (no drift from the registry)", () => {
    for (const name of ADDABLE_COMPONENTS) {
      const entry = COMPONENT_DEFAULTS[name];
      assert.ok(entry, name);
      const schemaFields = Object.keys(entry.comp).sort();
      const defaulted = Object.keys(entry.defaults).sort();
      assert.deepEqual(defaulted, schemaFields, `${name}: defaults must name every field of the component, no more, no fewer`);
      for (const v of Object.values(entry.defaults)) assert.ok(Number.isFinite(v), `${name}: defaults are finite numbers`);
    }
  });

  it("the authoring shelf's ECS-shaped adds are all addable", () => {
    // add-shelf.ts offers: CharacterRef, Health + Stamina, PlayerIntent,
    // FlowRef, VfxEmitter, AudioEmitter, and Collider — whose ECS form
    // is BodyConfig (scene-spawn's colliderOf writes one at spawn).
    for (const name of ["CharacterRef", "Health", "Stamina", "PlayerIntent", "FlowRef", "VfxEmitter", "AudioEmitter", "BodyConfig"]) {
      assert.ok(ADDABLE_COMPONENTS.includes(name), name);
    }
  });
});

describe("admin add-component: applyAddComponent", () => {
  it("adds a missing component with its defaults, on the live world", () => {
    const { sim, bare } = world();
    const { eid, wire } = bare();
    assert.equal(hasComponent(sim.ecs, C.Health, eid), false);
    const r = applyAddComponent(sim, wire, "Health");
    assert.equal(r.ok, true);
    assert.match(r.message, /Health added/);
    assert.equal(hasComponent(sim.ecs, C.Health, eid), true);
    assert.equal(C.Health.current[eid], 100);
    assert.equal(C.Health.max[eid], 100);
  });

  it("the added component is visible in inspect output, with its defaults", () => {
    const { sim, bare } = world();
    const { wire } = bare();
    assert.equal(applyAddComponent(sim, wire, "FlowRef").ok, true);
    assert.equal(applyAddComponent(sim, wire, "Stamina").ok, true);
    const dump = inspectEntity(sim, wire);
    assert.ok(dump);
    assert.match(dump, /FlowRef: graph 0 enabled 1/);
    assert.match(dump, /Stamina: 100\/100/);
  });

  it("adding a component the entity already has refuses, and changes nothing", () => {
    const { sim, bare } = world();
    const { eid, wire } = bare();
    assert.equal(applyAddComponent(sim, wire, "Health").ok, true);
    C.Health.current[eid] = 37; // a later edit the refused re-add must not clobber
    const r = applyAddComponent(sim, wire, "Health");
    assert.equal(r.ok, false);
    assert.match(r.message, /already has Health/);
    assert.equal(C.Health.current[eid], 37);
  });

  it("a component with no defined defaults refuses, naming the addable set", () => {
    const { sim, bare } = world();
    const { wire } = bare();
    const r = applyAddComponent(sim, wire, "PathState");
    assert.equal(r.ok, false);
    assert.match(r.message, /no defined defaults/);
    assert.match(r.message, /Health/);
  });

  it("an unknown component name refuses as unknown", () => {
    const { sim, bare } = world();
    const { wire } = bare();
    const r = applyAddComponent(sim, wire, "Nope");
    assert.equal(r.ok, false);
    assert.match(r.message, /unknown component/);
  });

  it("an unknown entity refuses as unknown", () => {
    const { sim } = world();
    const r = applyAddComponent(sim, 999999999999n, "Health");
    assert.equal(r.ok, false);
    assert.match(r.message, /unknown entity/);
  });

  it("defaults are written, never inherited from a recycled slot", () => {
    const { sim, bare } = world();
    const { eid, wire } = bare();
    // Poison the row the way a previous entity's life could have.
    C.VfxEmitter.template[eid] = 777;
    C.VfxEmitter.intensity[eid] = 0.25;
    const r = applyAddComponent(sim, wire, "VfxEmitter");
    assert.equal(r.ok, true);
    assert.equal(C.VfxEmitter.template[eid], 0);
    assert.equal(C.VfxEmitter.intensity[eid], 1);
  });
});
