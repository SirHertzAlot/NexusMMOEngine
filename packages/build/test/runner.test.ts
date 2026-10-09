/**
 * TDD: the pipeline runner — expands inputs, skips unchanged stages,
 * runs the rest in order, fail-fast.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectInputFiles, runProfile } from "../src/runner.js";
import type { BuildProfile } from "../src/profile.js";

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "build-run-"));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

describe("collectInputFiles", () => {
  it("expands files and directories, sorted, deduped", () => {
    write("c/b.txt", "b");
    write("c/a.txt", "a");
    write("c/sub/d.txt", "d");
    write("top.txt", "t");
    const got = collectInputFiles(tmp, ["c", "top.txt", "c/a.txt"]);
    assert.deepEqual(got, ["c/a.txt", "c/b.txt", "c/sub/d.txt", "top.txt"]);
  });

  it("throws on a missing input", () => {
    assert.throws(() => collectInputFiles(tmp, ["missing.txt"]));
  });
});

describe("runProfile", () => {
  function profile(stages: BuildProfile["stages"]): BuildProfile {
    return { name: "t", stages };
  }

  it("runs stages in order and skips unchanged ones on the second run", async () => {
    write("r/in.txt", "v1");
    const cacheDir = path.join(tmp, "cache1");
    const p = profile([
      { id: "a", command: "node -e \"process.exit(0)\"", inputs: ["r/in.txt"] },
      { id: "b", command: "node -e \"process.exit(0)\"", inputs: ["r/in.txt"] },
    ]);
    const first = await runProfile(tmp, p, { cacheDir });
    assert.deepEqual(first.map((r) => [r.id, r.skipped]), [["a", false], ["b", false]]);
    const second = await runProfile(tmp, p, { cacheDir });
    assert.deepEqual(second.map((r) => [r.id, r.skipped]), [["a", true], ["b", true]]);
  });

  it("re-runs a stage when its inputs change", async () => {
    write("r2/in.txt", "v1");
    const cacheDir = path.join(tmp, "cache2");
    const p = profile([{ id: "a", command: "node -e \"process.exit(0)\"", inputs: ["r2/in.txt"] }]);
    await runProfile(tmp, p, { cacheDir });
    write("r2/in.txt", "v2");
    const rerun = await runProfile(tmp, p, { cacheDir });
    assert.equal(rerun[0]?.skipped, false);
  });

  it("fail-fast: a failing stage stops the pipeline", async () => {
    write("r3/in.txt", "v1");
    const p = profile([
      { id: "bad", command: "node -e \"process.exit(3)\"", inputs: ["r3/in.txt"] },
      { id: "never", command: "node -e \"process.exit(0)\"", inputs: ["r3/in.txt"] },
    ]);
    const res = await runProfile(tmp, p, { cacheDir: path.join(tmp, "cache3") });
    assert.equal(res[0]?.exitCode, 3);
    assert.equal(res[0]?.skipped, false);
    assert.equal(res.length, 1, "pipeline stops after the failure");
  });

  it("dryRun runs nothing but reports what would run", async () => {
    write("r4/in.txt", "v1");
    const p = profile([{ id: "a", command: "node -e \"process.exit(0)\"", inputs: ["r4/in.txt"] }]);
    const res = await runProfile(tmp, p, { cacheDir: path.join(tmp, "cache4"), dryRun: true });
    assert.equal(res[0]?.skipped, false);
    assert.equal(res[0]?.exitCode, null);
    // Nothing was cached: a real run still runs.
    const real = await runProfile(tmp, p, { cacheDir: path.join(tmp, "cache4") });
    assert.equal(real[0]?.skipped, false);
  });

  it("onStage fires after each stage, in order", async () => {
    write("r5/in.txt", "v1");
    const seen: string[] = [];
    const p = profile([
      { id: "a", command: "node -e \"process.exit(0)\"", inputs: ["r5/in.txt"] },
      { id: "b", command: "node -e \"process.exit(0)\"", inputs: ["r5/in.txt"] },
    ]);
    await runProfile(tmp, p, {
      cacheDir: path.join(tmp, "cache5"),
      onStage: (r) => seen.push(`${r.id}:${r.skipped ? "skipped" : r.exitCode}`),
    });
    assert.deepEqual(seen, ["a:0", "b:0"]);
    // Second run: both skipped, still reported.
    seen.length = 0;
    await runProfile(tmp, p, {
      cacheDir: path.join(tmp, "cache5"),
      onStage: (r) => seen.push(`${r.id}:${r.skipped ? "skipped" : r.exitCode}`),
    });
    assert.deepEqual(seen, ["a:skipped", "b:skipped"]);
  });
});
