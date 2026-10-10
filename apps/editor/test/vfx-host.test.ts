/**
 * VFX host (EA22): lists content/vfx/effects/*.json, validates a save with
 * the engine-agnostic VfxEffect schema from @mmo-engine/art, writes only
 * valid documents. Writes go to a throwaway repo root, never the real content.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleVfxRoute } from "../src/vfx-host.js";

const REPO = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));
const ROOT = join(tmpdir(), `mmo-vfx-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
const readBody = (content: unknown) => async () => JSON.stringify({ content });

const validEffect = {
  id: "test-burst",
  name: "Test Burst",
  version: 1,
  emitters: [
    {
      name: "main",
      rate: 100,
      bursts: [],
      duration: 0,
      looping: true,
      maxParticles: 200,
      spawnShape: { kind: "sphere", radius: 0.5 },
      speed: 5,
      direction: { x: 0, y: 1, z: 0 },
      spread: 0.2,
      lifetime: 1.5,
      size: 0.3,
      color: { r: 1, g: 0.5, b: 0, a: 1 },
      forces: [],
      position: { x: 0, y: 0, z: 0 },
    },
  ],
};

before(() => {
  mkdirSync(join(ROOT, "content", "vfx", "effects"), { recursive: true });
  // The schema is read from <root>/packages/art/dist: borrow the real build.
  mkdirSync(join(ROOT, "packages"), { recursive: true });
  symlinkSync(join(REPO, "packages", "art"), join(ROOT, "packages", "art"), "junction");
});
after(() => rmSync(ROOT, { recursive: true, force: true }));

describe("vfx routes", () => {
  it("ignores other paths", async () => {
    assert.equal(await handleVfxRoute(ROOT, "GET", "/api/editor/flow", readBody({})), null);
  });

  it("GET /effects lists effect ids", async () => {
    writeFileSync(join(ROOT, "content", "vfx", "effects", "a.json"), "{}");
    writeFileSync(join(ROOT, "content", "vfx", "effects", "b.json"), "{}");
    const r = await handleVfxRoute(ROOT, "GET", "/api/editor/vfx/effects", readBody({}));
    assert.equal(r?.status, 200);
    assert.deepEqual((r?.body as { effects: string[] }).effects, ["a", "b"]);
  });

  it("PUT validates with the VfxEffect schema", async () => {
    const r = await handleVfxRoute(ROOT, "PUT", "/api/editor/vfx/effects/test-burst", readBody(validEffect));
    assert.equal(r?.status, 200);
  });

  it("PUT rejects invalid effects", async () => {
    const bad = { ...validEffect, emitters: [] }; // min(1) fails
    const err = await handleVfxRoute(ROOT, "PUT", "/api/editor/vfx/effects/bad", readBody(bad)).then(
      () => null,
      (e: unknown) => e as { issues?: { path: string }[] },
    );
    assert.ok(err, "expected a rejection");
    assert.ok(err.issues?.some((i) => i.path.includes("emitters")), `issues: ${JSON.stringify(err.issues)}`);
  });

  it("GET returns the saved document", async () => {
    await handleVfxRoute(ROOT, "PUT", "/api/editor/vfx/effects/test-burst", readBody(validEffect));
    const r = await handleVfxRoute(ROOT, "GET", "/api/editor/vfx/effects/test-burst", readBody({}));
    assert.equal(r?.status, 200);
    assert.equal((r?.body as { content: { id: string } }).content.id, "test-burst");
  });

  it("GET 404s on missing effect", async () => {
    const r = await handleVfxRoute(ROOT, "GET", "/api/editor/vfx/effects/nope", readBody({}));
    assert.equal(r?.status, 404);
  });
});
