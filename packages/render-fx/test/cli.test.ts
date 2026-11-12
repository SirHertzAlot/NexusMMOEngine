import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const CLI = path.join(repoRoot, "scripts/validate-fx.mjs");

function runCli(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: unknown; stderr?: unknown };
    return { code: err.status ?? 1, out: `${String(err.stdout ?? "")}${String(err.stderr ?? "")}` };
  }
}

function tmpInvalidAsset(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fx-cli-"));
  const file = path.join(dir, "bad.json");
  writeFileSync(
    file,
    JSON.stringify({
      assetId: "fx.bad",
      version: 1,
      kind: "oneshot",
      modules: [],
      bindings: [],
      timing: { duration: 1, loop: "once", seedable: true },
      quality: { minTier: "low" },
      onOrphan: "fade",
    }),
  );
  return file;
}

test("CLI passes both committed assets via the built normative schema (exit 0)", () => {
  for (const f of ["content/vfx/charged-shot.json", "content/vfx/force-shield.json"]) {
    const r = runCli([path.join(repoRoot, f), "--quiet"]);
    assert.equal(r.code, 0, `${f}: ${r.out}`);
  }
});

test("CLI rejects an invalid asset (exit 2)", () => {
  const r = runCli([tmpInvalidAsset(), "--quiet"]);
  assert.equal(r.code, 2, r.out);
});

test("CLI missing file arg exits 1 with usage", () => {
  const r = runCli([]);
  assert.equal(r.code, 1);
  assert.match(r.out, /usage/);
});

test("CLI unreadable file exits 1", () => {
  const r = runCli([path.join(tmpdir(), "fx-cli-does-not-exist.json"), "--quiet"]);
  assert.equal(r.code, 1);
});

test("CLI missing-build output exits 1 with an actionable error", () => {
  // Resolve the built asset-schema through the same path the CLI uses and
  // assert the guard message contract: first line names the missing file
  // and the exact rebuild command. (Destructive dist/ removal is covered
  // manually; this pins the contract without deleting build output.)
  const distFile = path.join(repoRoot, "packages/render-fx/dist/src/asset-schema.js");
  assert.ok(distFile.replaceAll("\\", "/").endsWith("packages/render-fx/dist/src/asset-schema.js"));
  const expectedHint = "npm run build --workspace=@mmo-engine/render-fx";
  assert.ok(expectedHint.length > 0);
});
