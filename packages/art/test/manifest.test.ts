import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  parseManifestJSON,
  checkManifestFiles,
  type AssetManifest,
} from "../src/manifest.js";

const VALID = {
  name: "my-pack",
  version: "1.0.0",
  models: [{ id: "player", file: "models/player.glb", forShape: "1" }],
  textures: [{ id: "grass", file: "textures/grass.png" }],
};

describe("parseManifestJSON", () => {
  it("parses a valid manifest", () => {
    const manifest: AssetManifest = parseManifestJSON(VALID);
    assert.equal(manifest.name, "my-pack");
    assert.equal(manifest.version, "1.0.0");
    assert.deepEqual(manifest.models, [{ id: "player", file: "models/player.glb", forShape: "1" }]);
    assert.deepEqual(manifest.textures, [{ id: "grass", file: "textures/grass.png" }]);
  });

  it("accepts empty sections and optional tags", () => {
    const manifest = parseManifestJSON({ name: "p", version: "0.1.0", models: [], textures: [] });
    assert.deepEqual(manifest.models, []);
    assert.deepEqual(manifest.textures, []);
  });

  it("rejects a manifest missing the models section", () => {
    assert.throws(
      () => parseManifestJSON({ name: "p", version: "1.0.0", textures: [] }),
      z.ZodError,
    );
  });

  it("rejects a manifest missing the textures section", () => {
    assert.throws(
      () => parseManifestJSON({ name: "p", version: "1.0.0", models: [] }),
      z.ZodError,
    );
  });

  it("rejects path traversal (../evil.glb)", () => {
    assert.throws(
      () =>
        parseManifestJSON({
          ...VALID,
          models: [{ id: "evil", file: "../evil.glb" }],
        }),
      (err) => err instanceof z.ZodError && err.issues.some((i) => i.message.includes("..")),
    );
  });

  it("rejects a bare '..' path", () => {
    assert.throws(
      () =>
        parseManifestJSON({
          ...VALID,
          textures: [{ id: "evil", file: ".." }],
        }),
      z.ZodError,
    );
  });

  it("rejects absolute POSIX paths (/etc/passwd)", () => {
    assert.throws(
      () =>
        parseManifestJSON({
          ...VALID,
          models: [{ id: "evil", file: "/etc/passwd" }],
        }),
      (err) => err instanceof z.ZodError && err.issues.some((i) => i.message.includes("absolute")),
    );
  });

  it("rejects Windows absolute paths and backslash separators", () => {
    assert.throws(
      () =>
        parseManifestJSON({
          ...VALID,
          models: [{ id: "evil", file: "C:\\packs\\evil.glb" }],
        }),
      z.ZodError,
    );
  });

  it("rejects duplicate ids within a section", () => {
    assert.throws(
      () =>
        parseManifestJSON({
          ...VALID,
          models: [
            { id: "player", file: "models/a.glb" },
            { id: "player", file: "models/b.glb" },
          ],
        }),
      (err) => err instanceof z.ZodError && err.issues.some((i) => i.message.includes("duplicated")),
    );
  });

  it("allows the same id across models and textures", () => {
    const manifest = parseManifestJSON({
      ...VALID,
      textures: [{ id: "player", file: "textures/player.png" }],
    });
    assert.equal(manifest.textures[0]?.id, "player");
  });
});

describe("checkManifestFiles", () => {
  const manifest = parseManifestJSON(VALID);

  it("reports referenced files missing from the pack", () => {
    const diagnostics = checkManifestFiles(
      manifest,
      new Set(["models/player.glb"]),
    );
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0] ?? "", /texture "grass".*textures\/grass\.png.*missing/);
  });

  it("reports nothing when the pack is complete", () => {
    const diagnostics = checkManifestFiles(
      manifest,
      new Set(["models/player.glb", "textures/grass.png"]),
    );
    assert.deepEqual(diagnostics, []);
  });

  it("reports every missing file, models then textures", () => {
    const diagnostics = checkManifestFiles(manifest, new Set());
    assert.equal(diagnostics.length, 2);
    assert.match(diagnostics[0] ?? "", /model "player"/);
    assert.match(diagnostics[1] ?? "", /texture "grass"/);
  });
});
