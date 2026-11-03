/**
 * WL1: a generated placeholder pack goes through the real GLB importer into a
 * catalog and manifest (in temp folders, never assets/), with its licence marked
 * as a placeholder.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importGlbPacks } from "../src/convert/import-glb-packs.js";
import { makePlaceholderPack, PLACEHOLDER_LICENCE } from "../src/convert/placeholder-pack.js";

describe("placeholder packs through the GLB importer", () => {
  it("imports generated animals into the catalog and manifest, marked as placeholders", async () => {
    const root = mkdtempSync(join(tmpdir(), "placeholder-pack-"));
    const pack = join(root, "poly-pizza-placeholder-wildlife");
    const assets = join(root, "assets");
    await makePlaceholderPack(pack, [
      { title: "Deer", publicID: "d1" },
      { title: "Sheep", publicID: "s1" },
    ]);

    const [sum] = importGlbPacks({ assetsRoot: assets, packDirs: [pack], log: () => {} });
    assert.ok(sum, "one pack imported");
    assert.equal(sum.slug, "placeholder-wildlife");
    assert.equal(sum.models, 2);
    assert.equal(sum.licences[PLACEHOLDER_LICENCE], 2, "both are marked as placeholders");

    const catalog = JSON.parse(fs.readFileSync(join(assets, "catalog.json"), "utf8")) as {
      models: Array<{ id: string; file: string; license: { name: string | null }; size: number[] }>;
    };
    assert.equal(catalog.models.length, 2);
    for (const m of catalog.models) {
      assert.equal(m.license.name, PLACEHOLDER_LICENCE);
      assert.ok(fs.existsSync(join(assets, m.file)), `${m.file} written`);
      assert.ok(m.size.every((v) => v > 0), "a real size in metres");
    }

    const manifest = JSON.parse(fs.readFileSync(join(assets, "manifest.json"), "utf8")) as { models: Array<{ id: string }> };
    assert.deepEqual(manifest.models.map((m) => m.id).sort(), catalog.models.map((m) => m.id).sort());
  });
});
