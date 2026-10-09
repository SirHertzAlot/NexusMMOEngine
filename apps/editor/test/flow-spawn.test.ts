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
import { resolveSpawnTarget, type SpawnTarget } from "../src/flow-spawn.js";

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

  it("Login → preview", () => {
    const t = resolveSpawnTarget("Login", null) as Extract<SpawnTarget, { kind: "preview" }>;
    assert.equal(t.kind, "preview");
    assert.ok(t.reason.length > 0);
  });

  it("Character creation → preview", () => {
    const t = resolveSpawnTarget("Character creation", null) as Extract<SpawnTarget, { kind: "preview" }>;
    assert.equal(t.kind, "preview");
    assert.ok(t.reason.length > 0);
  });

  it("unknown value → default (never crashes)", () => {
    assert.deepEqual(resolveSpawnTarget("???", null), { kind: "default" });
  });
});
