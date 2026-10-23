import { test } from "node:test";
import assert from "node:assert/strict";
import {
  despawnCommand,
  editableField,
  healCommand,
  inspectCommand,
  sendAdmin,
  serverComponent,
  setCommand,
  teleportHereCommand,
} from "../src/inspectors/entity-actions.js";

test("card component names map to the server's set names", () => {
  assert.equal(serverComponent("Intent"), "PlayerIntent");
  assert.equal(serverComponent("Transform"), "Transform");
  assert.equal(editableField("Intent", "lookYaw"), true);
  assert.equal(editableField("Transform", "px"), true);
  assert.equal(editableField("Health", "max"), true);
  assert.equal(editableField("Velocity", "lx"), true);
  assert.equal(editableField("BodyConfig", "mass"), true);
  // Off the whitelist: read-only.
  assert.equal(editableField("Stamina", "current"), false);
  assert.equal(editableField("Appearance", "look"), false);
  assert.equal(editableField("Transform", "nope"), false);
});

test("set is built from the typed text and checked like the server checks it", () => {
  assert.deepEqual(setCommand("42", "Transform", "px", " 12.5 "), {
    command: "set",
    args: { entity: "42", component: "Transform", field: "px", value: 12.5 },
  });
  assert.deepEqual(setCommand("42", "Intent", "jump", "true"), {
    command: "set",
    args: { entity: "42", component: "PlayerIntent", field: "jump", value: 1 },
  });
  assert.match((setCommand("42", "Health", "current", "abc") as { error: string }).error, /not a number/);
  assert.match((setCommand("42", "Health", "current", "") as { error: string }).error, /not a number/);
  assert.match((setCommand("42", "BodyConfig", "layer", "1.5") as { error: string }).error, /integer/);
  assert.match((setCommand("42", "Stamina", "current", "5") as { error: string }).error, /read-only/);
});

test("inspect, despawn, heal and teleport-me-here commands", () => {
  assert.deepEqual(inspectCommand("7"), { command: "inspect", args: { entity: "7" } });
  assert.deepEqual(despawnCommand("7"), { command: "despawn", args: { entity: "7" } });
  const entity = { wireId: 7n, health: { wireId: 7n, current: 3, max: 80 }, transform: { wireId: 7n, px: 10.5, py: 2, pz: -4 } };
  assert.deepEqual(healCommand(entity), { command: "set", args: { entity: "7", component: "Health", field: "current", value: 80 } });
  assert.deepEqual(teleportHereCommand(entity), { command: "teleport", args: { x: 10.5, z: -4 } });
  assert.deepEqual(healCommand({ wireId: 7n }), { error: "no Health" });
  assert.deepEqual(teleportHereCommand({ wireId: 7n }), { error: "no Transform" });
});

test("sendAdmin surfaces the server's refusal", async () => {
  const sent: unknown[] = [];
  const ok = { admin: async (command: string, args?: unknown) => (sent.push([command, args]), { ok: true, message: "despawned 7" }) };
  assert.deepEqual(await sendAdmin(ok, despawnCommand("7")), { ok: true, message: "despawned 7" });
  assert.deepEqual(sent, [["despawn", { entity: "7" }]]);
  const refused = { admin: async () => Promise.reject(new Error("admin rejected: 4003 that is a live session's avatar")) };
  assert.deepEqual(await sendAdmin(refused, despawnCommand("7")), { ok: false, message: "that is a live session's avatar" });
  // Local errors never reach the client.
  assert.deepEqual(await sendAdmin(refused, { error: "no Health" }), { ok: false, message: "no Health" });
});
