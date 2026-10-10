/**
 * TDD: "Start from" spawn resolution for the Play menu.
 *
 * The menu's `from` choice maps to a spawn target:
 * - "World" → default spawn (no override).
 * - "Camera position" → the scene viewport camera's ground position.
 * - "Login" / "Character creation" → preview: they need the client to run
 *   the actual login/creation UI instead of auto-login (not a spawn point).
 * - anything else → default (safe fallback, never a crash).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSpawnTarget } from "../src/flow-spawn.js";

describe("resolveSpawnTarget", () => {
  it("World → default", () => {
    assert.deepEqual(resolveSpawnTarget("World", null), { kind: "default" });
  });

  it("Camera position with a known camera → at", () => {
    const t = resolveSpawnTarget("Camera position", { x: 12.5, z: -3 });
    assert.equal(t.kind, "at");
    if (t.kind === "at") {
      assert.equal(t.x, 12.5);
      assert.equal(t.z, -3);
    }
  });

  it("Camera position with no camera → default with a note", () => {
    const t = resolveSpawnTarget("Camera position", null);
    assert.equal(t.kind, "default");
    assert.ok((t as { note?: string }).note);
  });

  it("Login and Character creation start the player's client at that flow node", () => {
    assert.deepEqual(resolveSpawnTarget("Login", null), { kind: "node", node: "login" });
    assert.deepEqual(resolveSpawnTarget("Character creation", null), { kind: "node", node: "character-creation" });
    assert.deepEqual(resolveSpawnTarget("character-select", null), { kind: "node", node: "character-select" });
  });

  it("the flow's world node is the default spawn, whatever it is called", () => {
    assert.deepEqual(resolveSpawnTarget("world", null), { kind: "default" });
    assert.deepEqual(resolveSpawnTarget("realm", null, "realm"), { kind: "default" });
  });
});
