/**
 * Asset ID → URL resolution (EA15).
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAssetUrl } from "../src/asset-resolve.js";

describe("resolveAssetUrl", () => {
  let repoRoot: string;

  before(() => {
    repoRoot = join(tmpdir(), `asset-resolve-test-${Date.now()}`);
    const assetsDir = join(repoRoot, "assets");
    mkdirSync(join(assetsDir, "models"), { recursive: true });
    writeFileSync(
      join(assetsDir, "manifest.json"),
      JSON.stringify({
        name: "test-pack",
        version: "1",
        models: [{ id: "goblin", file: "models/goblin.glb" }],
        textures: [{ id: "grass", file: "textures/grass.png" }],
      })
    );
  });

  it("resolves a model ID to its URL", () => {
    const r = resolveAssetUrl(repoRoot, "goblin");
    assert.equal(r.ok, true);
    assert.equal(r.url, "/assets/models/goblin.glb");
  });

  it("resolves a texture ID to its URL", () => {
    const r = resolveAssetUrl(repoRoot, "grass");
    assert.equal(r.ok, true);
    assert.equal(r.url, "/assets/textures/grass.png");
  });

  it("404s on unknown ID", () => {
    const r = resolveAssetUrl(repoRoot, "nope");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not found/);
  });

  it("404s when assets/ is missing", () => {
    const r = resolveAssetUrl(join(tmpdir(), "definitely-not-here"), "goblin");
    assert.equal(r.ok, false);
  });

  it("rejects path traversal", () => {
    const evilRoot = join(tmpdir(), `asset-evil-${Date.now()}`);
    const assetsDir = join(evilRoot, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(
      join(assetsDir, "manifest.json"),
      JSON.stringify({
        name: "evil",
        version: "1",
        models: [{ id: "evil", file: "../../../etc/passwd" }],
        textures: [],
      })
    );
    const r = resolveAssetUrl(evilRoot, "evil");
    assert.equal(r.ok, false);
    rmSync(evilRoot, { recursive: true, force: true });
  });
});
