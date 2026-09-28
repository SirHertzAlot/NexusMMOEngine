import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanAssetDir } from "../src/scan.js";

// Fixtures live next to the test sources; resolve from the compiled test's
// location so the path works no matter where node --test is invoked from.
const FIXTURES = fileURLToPath(new URL("../../test/fixtures", import.meta.url));

describe("scanAssetDir", () => {
  it("finds models and textures with ids from basenames", () => {
    const { manifest, diagnostics } = scanAssetDir(join(FIXTURES, "pack-a"));
    assert.deepEqual(diagnostics, []);
    assert.equal(manifest.name, "pack-a");
    assert.equal(manifest.version, "0.0.0-scan");
    assert.deepEqual(
      manifest.models.map((m) => m.id),
      ["crate", "enemy", "player"],
    );
    assert.deepEqual(
      manifest.textures.map((t) => t.id),
      ["grass", "rock"],
    );
  });

  it("records POSIX-relative file paths, including nested dirs", () => {
    const { manifest } = scanAssetDir(join(FIXTURES, "pack-a"));
    const byId = new Map(manifest.models.map((m) => [m.id, m.file]));
    assert.equal(byId.get("player"), "models/player.glb");
    assert.equal(byId.get("enemy"), "models/enemy.gltf");
    assert.equal(byId.get("crate"), "models/props/crate.glb");
    const texById = new Map(manifest.textures.map((t) => [t.id, t.file]));
    assert.equal(texById.get("grass"), "textures/grass.png");
    assert.equal(texById.get("rock"), "textures/rock.jpg");
  });

  it("ignores non-asset files (notes.txt)", () => {
    const { manifest } = scanAssetDir(join(FIXTURES, "pack-a"));
    assert.ok(!manifest.models.some((m) => m.id === "notes"));
  });

  it("emits diagnostics instead of throwing on missing directories", () => {
    const empty = mkdtempSync(join(tmpdir(), "art-scan-"));
    const { manifest, diagnostics } = scanAssetDir(empty);
    assert.deepEqual(manifest.models, []);
    assert.deepEqual(manifest.textures, []);
    assert.equal(diagnostics.length, 2);
    assert.ok(diagnostics.every((d) => d.includes("not found")));
  });

  it("emits diagnostics instead of throwing on a missing pack root", () => {
    const { diagnostics } = scanAssetDir(join(tmpdir(), "art-scan-does-not-exist"));
    assert.equal(diagnostics.length, 2);
  });
});
