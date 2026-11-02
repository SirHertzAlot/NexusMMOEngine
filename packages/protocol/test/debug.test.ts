import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  decodeEnvelope,
  encodeControl,
  encodeEnvelope,
  MessageType,
} from "../src/index.js";
import type { DebugQuery, DebugResponse } from "../src/index.js";

test("debug queries round-trip as control JSON (0x0a)", () => {
  const queries: DebugQuery[] = [
    { kind: "debug", query: "waypoints", entity: "18446744073709551615" },
    { kind: "debug", query: "tiles" },
    { kind: "debug", query: "colliders", x: 512, z: 632, radius: 64 },
  ];
  for (const q of queries) {
    const wire = encodeEnvelope(MessageType.Debug, encodeControl(q));
    assert.equal(wire[0], 0x0a);
    const { type, payload } = decodeEnvelope(wire);
    assert.equal(type, MessageType.Debug);
    assert.deepEqual(decodeControl<DebugQuery>(payload), q);
  }
});

test("debug responses round-trip as control JSON (0x0a)", () => {
  const responses: DebugResponse[] = [
    {
      kind: "debug",
      query: "waypoints",
      entity: "42",
      status: "active",
      waypoints: [
        [1, 0, 2],
        [3, 0, 4],
      ],
    },
    {
      kind: "debug",
      query: "waypoints",
      entity: "42",
      status: "unknown",
      waypoints: [],
    },
    {
      kind: "debug",
      query: "tiles",
      tiles: [[0, 0, 16, 16]],
    },
    {
      kind: "debug",
      query: "colliders",
      total: 1,
      colliders: [
        { id: "7", shape: 0, motion: 0, x: 1, y: 2, z: 3, hx: 5, hy: 6, hz: 9, r: 0, yaw: 0.5, asset: 123 },
      ],
    },
  ];
  for (const r of responses) {
    const { type, payload } = decodeEnvelope(
      encodeEnvelope(MessageType.Debug, encodeControl(r)),
    );
    assert.equal(type, MessageType.Debug);
    assert.deepEqual(decodeControl<DebugResponse>(payload), r);
  }
});
