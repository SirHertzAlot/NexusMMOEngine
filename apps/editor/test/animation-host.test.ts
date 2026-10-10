/**
 * TDD: EA21 animation host routes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAnimationRoute } from "../src/animation-host.js";

const makeRoot = (clips?: unknown): string => {
  const root = mkdtempSync(join(tmpdir(), "anim-test-"));
  if (clips !== undefined) {
    mkdirSync(join(root, "content", "animation"), { recursive: true });
    writeFileSync(join(root, "content", "animation", "clips.json"), JSON.stringify(clips));
  }
  return root;
};

describe("handleAnimationRoute", () => {
  it("GET returns the shipped default when no file exists", async () => {
    const root = makeRoot();
    const reply = await handleAnimationRoute(root, "GET", "/api/editor/animation/clips", undefined, async () => "");
    assert.equal(reply?.status, 200);
    assert.equal((reply?.body as { ok: boolean }).ok, true);
    assert.equal((reply?.body as { saved: boolean }).saved, false);
  });

  it("GET returns the saved map when the file exists", async () => {
    const root = makeRoot({ version: 1, clips: [{ id: 1, name: "idle", clip: "Idle_Loop", loop: true, fade: 0.2 }] });
    const reply = await handleAnimationRoute(root, "GET", "/api/editor/animation/clips", undefined, async () => "");
    assert.equal(reply?.status, 200);
    assert.equal((reply?.body as { saved: boolean }).saved, true);
  });

  it("PUT validates and writes", async () => {
    const root = makeRoot();
    const map = { version: 1, clips: [{ id: 1, name: "idle", clip: "Idle_Loop", loop: true, fade: 0.2 }] };
    const reply = await handleAnimationRoute(
      root, "PUT", "/api/editor/animation/clips", "application/json",
      async () => JSON.stringify({ map }),
    );
    assert.equal(reply?.status, 200);
  });

  it("PUT refuses an invalid map", async () => {
    const root = makeRoot();
    const reply = await handleAnimationRoute(
      root, "PUT", "/api/editor/animation/clips", "application/json",
      async () => JSON.stringify({ map: { version: 1, clips: [{ id: -1 }] } }),
    );
    assert.equal(reply?.status, 400);
  });

  it("returns null for other paths", async () => {
    const root = makeRoot();
    const reply = await handleAnimationRoute(root, "GET", "/api/editor/other", undefined, async () => "");
    assert.equal(reply, null);
  });
});
