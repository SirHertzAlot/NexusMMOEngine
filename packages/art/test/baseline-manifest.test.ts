import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// TL0: every baseline fixture carries a load time and a screenshot hash, recorded
// by apps/client/scripts/art-baselines.mjs (npm run bench:art-baselines).
const BASELINES = fileURLToPath(new URL("../../test/fixtures/baselines", import.meta.url));

interface BaselineAsset {
  file: string;
  bytes: number;
  loadMs: number | null;
  screenshotSha256?: string;
}

interface BaselineManifest {
  assets: BaselineAsset[];
  environment?: { browser: string; gpu: string; measuredOn: string };
}

const manifest: BaselineManifest = JSON.parse(readFileSync(join(BASELINES, "manifest.json"), "utf8"));

describe("TL0 baseline manifest", () => {
  it("lists the three fixtures, and their bytes match the files on disk", () => {
    assert.deepEqual(manifest.assets.map((a) => a.file).sort(), [
      "character-humanoid.glb",
      "prop-crate.glb",
      "vista-terrain.glb",
    ]);
    for (const a of manifest.assets) {
      assert.equal(readFileSync(join(BASELINES, a.file)).length, a.bytes, `${a.file}: bytes`);
    }
  });

  it("records a load time and a screenshot hash for each fixture", () => {
    for (const a of manifest.assets) {
      assert.equal(typeof a.loadMs, "number", `${a.file}: loadMs`);
      assert.ok((a.loadMs as number) > 0, `${a.file}: loadMs is positive`);
      assert.match(a.screenshotSha256 ?? "", /^[0-9a-f]{64}$/, `${a.file}: screenshotSha256`);
    }
  });

  it("says where the baselines were measured", () => {
    assert.ok(manifest.environment?.browser, "environment.browser");
    assert.ok(manifest.environment?.gpu, "environment.gpu");
    assert.match(manifest.environment?.measuredOn ?? "", /^\d{4}-\d{2}-\d{2}$/, "environment.measuredOn");
  });
});
