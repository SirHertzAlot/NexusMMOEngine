/**
 * Baking a settlement to a file and reading it back: the file is the
 * manifest, and a reader refuses one whose hash no longer matches its body.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateScene } from "@mmo-engine/scene";
import { bakeSettlement, readSettlement } from "../src/index.js";

const request = { settlementId: "0182", seed: 1234, population: 600 };
const tmp = (): string => mkdtempSync(join(tmpdir(), "settlement-"));

describe("bakeSettlement", () => {
  it("writes <id>.settlement.json that reads back as the same manifest", () => {
    const out = tmp();
    const r = bakeSettlement(request, out);
    assert.ok(r.ok);
    assert.equal(r.file, join(out, "0182.settlement.json"));
    assert.deepEqual(readSettlement(r.file), r.manifest);
  });

  it("writes nothing when generation fails", () => {
    const out = tmp();
    const r = bakeSettlement({ ...request, population: 0 }, out);
    assert.ok(!r.ok);
    assert.throws(() => readFileSync(join(out, "0182.settlement.json")));
  });

  it("refuses a file edited after it was baked", () => {
    const out = tmp();
    const r = bakeSettlement(request, out);
    assert.ok(r.ok);
    const doc = JSON.parse(readFileSync(r.file, "utf8"));
    doc.structures[0].archetype = "smithy";
    writeFileSync(r.file, JSON.stringify(doc));
    assert.throws(() => readSettlement(r.file), /hash/);
  });

  it("can also write the scene the spawner loads, as settlement-<id>.scene.json", () => {
    const out = tmp();
    const scenes = tmp();
    const r = bakeSettlement(request, out, { scene: { dir: scenes, origin: [100, 200] } });
    assert.ok(r.ok);
    const scene = JSON.parse(readFileSync(join(scenes, "settlement-0182.scene.json"), "utf8"));
    assert.deepEqual(validateScene(scene), []);
    assert.deepEqual(scene.nodes[0].transform.position, [100, 0, 200]);
  });
});
