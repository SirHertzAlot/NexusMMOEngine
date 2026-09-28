/**
 * Unit tests for the ECS inspector view-model (src/inspectors/ecs.ts).
 *
 * Pure logic: a fake snapshot provider feeds the inspector; no React, no DOM.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EcsInspector,
  type EntitySnapshot,
  type EntityView,
} from "../src/inspectors/ecs.js";

const IDENTITY_TRANSFORM = {
  px: 0, py: 0, pz: 0,
  qx: 0, qy: 0, qz: 0, qw: 1,
  sx: 1, sy: 1, sz: 1,
};

function makeProvider(): () => EntitySnapshot {
  const entities = new Map<bigint, EntityView>([
    [
      42n,
      {
        wireId: 42n,
        transform: { ...IDENTITY_TRANSFORM, px: 1.23456, py: 2, pz: 3 },
        health: { current: 80, max: 100 },
      },
    ],
    [
      7n,
      {
        wireId: 7n,
        transform: { ...IDENTITY_TRANSFORM, px: -4.5, py: 0.25, pz: 10 },
        velocity: { lx: 5, ly: 0, lz: -2, ax: 0, ay: 0.5, az: 0 },
        body: {
          shapeKind: 1,
          halfX: 0.5, halfY: 1, halfZ: 0.5,
          radius: 0.5,
          mass: 70,
          motionType: 0,
          layer: 1,
          friction: 0.6,
          restitution: 0.1,
        },
      },
    ],
    [
      1234n,
      {
        wireId: 1234n,
        chunk: { chunkId: 1234n, seed: 987654321n, lod: 2 },
      },
    ],
    [9n, { wireId: 9n }],
    [
      4242n,
      {
        wireId: 4242n,
        transform: IDENTITY_TRANSFORM,
        intent: {
          mx: 1, my: 0, mz: 0,
          lookYaw: 0.12345, lookPitch: 0,
          jump: true, buttons: 3,
        },
      },
    ],
  ]);
  return () => ({ tick: 1234, entities });
}

describe("EcsInspector", () => {
  it("returns all entities sorted by wire id ascending with an empty filter", () => {
    const rows = new EcsInspector(makeProvider()).listEntities({});
    assert.deepEqual(
      rows.map((r) => r.wireId),
      ["7", "9", "42", "1234", "4242"],
    );
  });

  it("text filter matches wire-id decimal substring (case-insensitive)", () => {
    const inspector = new EcsInspector(makeProvider());
    const rows = inspector.listEntities({ text: "42" });
    assert.deepEqual(rows.map((r) => r.wireId), ["42", "4242"]);
  });

  it("component filter requires ALL listed components", () => {
    const inspector = new EcsInspector(makeProvider());
    const rows = inspector.listEntities({ components: ["transform", "velocity"] });
    assert.deepEqual(rows.map((r) => r.wireId), ["7"]);
  });

  it("component filter with a single component", () => {
    const inspector = new EcsInspector(makeProvider());
    const rows = inspector.listEntities({ components: ["chunk"] });
    assert.deepEqual(rows.map((r) => r.wireId), ["1234"]);
  });

  it("combines text and component filters", () => {
    const inspector = new EcsInspector(makeProvider());
    const rows = inspector.listEntities({ text: "4", components: ["transform"] });
    assert.deepEqual(rows.map((r) => r.wireId), ["42", "4242"]);
  });

  it("reports present components and a human summary label", () => {
    const inspector = new EcsInspector(makeProvider());
    const byId = new Map(inspector.listEntities({}).map((r) => [r.wireId, r]));

    const e42 = byId.get("42");
    assert(e42 !== undefined);
    assert.deepEqual(e42.components, ["transform", "health"]);
    assert.equal(e42.label, "E42 · T(1.235,2,3) · HP 80/100");

    const e9 = byId.get("9");
    assert(e9 !== undefined);
    assert.deepEqual(e9.components, []);
    assert.equal(e9.label, "E9");
  });

  it("getEntity projects fields with 3-decimal rounding and decimal bigints", () => {
    const views = new EcsInspector(makeProvider()).getEntity("42");
    assert(views !== undefined);
    assert.deepEqual(
      views.map((v) => v.component),
      ["transform", "health"],
    );
    const transform = views[0]?.fields;
    assert(transform !== undefined);
    assert.equal(transform.find((f) => f.key === "px")?.value, "1.235");
    assert.equal(transform.find((f) => f.key === "py")?.value, "2.000");
    assert.equal(transform.find((f) => f.key === "qw")?.value, "1.000");
    const health = views[1]?.fields;
    assert(health !== undefined);
    assert.equal(health.find((f) => f.key === "current")?.value, "80.000");
    assert.equal(health.find((f) => f.key === "max")?.value, "100.000");
  });

  it("getEntity projects chunk bigints as decimal strings", () => {
    const views = new EcsInspector(makeProvider()).getEntity("1234");
    assert(views !== undefined);
    assert.deepEqual(
      views.map((v) => v.component),
      ["chunk"],
    );
    const fields = views[0]?.fields;
    assert(fields !== undefined);
    assert.equal(fields.find((f) => f.key === "chunkId")?.value, "1234");
    assert.equal(fields.find((f) => f.key === "seed")?.value, "987654321");
    assert.equal(fields.find((f) => f.key === "lod")?.value, "2.000");
  });

  it("getEntity projects intent move flags and body config", () => {
    const inspector = new EcsInspector(makeProvider());

    const intent = inspector.getEntity("4242");
    assert(intent !== undefined);
    assert.deepEqual(
      intent.map((v) => v.component),
      ["transform", "intent"],
    );
    const intentFields = intent[1]?.fields;
    assert(intentFields !== undefined);
    assert.equal(intentFields.find((f) => f.key === "mx")?.value, "1.000");
    assert.equal(intentFields.find((f) => f.key === "lookYaw")?.value, "0.123");
    assert.equal(intentFields.find((f) => f.key === "jump")?.value, "true");
    assert.equal(intentFields.find((f) => f.key === "buttons")?.value, "3");

    const body = inspector.getEntity("7");
    assert(body !== undefined);
    const bodyFields = body.find((v) => v.component === "body")?.fields;
    assert(bodyFields !== undefined);
    assert.equal(bodyFields.find((f) => f.key === "shapeKind")?.value, "1");
    assert.equal(bodyFields.find((f) => f.key === "mass")?.value, "70.000");
  });

  it("getEntity returns undefined for an unknown wire id", () => {
    const inspector = new EcsInspector(makeProvider());
    assert.equal(inspector.getEntity("999"), undefined);
    assert.equal(inspector.getEntity("not-a-number"), undefined);
  });

  it("exposes the tick and entity count from the provider", () => {
    const inspector = new EcsInspector(makeProvider());
    assert.equal(inspector.getTick(), 1234);
    assert.equal(inspector.getEntityCount(), 5);
  });

  it("exposes a read-only notice for the UI", () => {
    const notice = new EcsInspector(makeProvider()).readonlyNotice;
    assert.equal(typeof notice, "string");
    assert(notice.length > 0);
    assert(notice.toLowerCase().includes("read-only"));
  });

  it("handles an empty snapshot without throwing", () => {
    const inspector = new EcsInspector(() => ({ tick: 0, entities: new Map() }));
    assert.deepEqual(inspector.listEntities({}), []);
    assert.equal(inspector.getEntityCount(), 0);
    assert.equal(inspector.getTick(), 0);
    assert.equal(inspector.getEntity("1"), undefined);
  });
});
