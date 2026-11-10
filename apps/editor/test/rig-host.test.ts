/** Rig host: content/rigs.local.json, validated saves, a refused save writes nothing. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRigRoute } from "../src/rig-host.js";

const DOC = { version: 1, models: { "demo/Deer": { headSign: -1 } } };
function fakeRepo(withFile = true): string {
  const root = join(tmpdir(), `mmo-rig-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  mkdirSync(join(root, "content"), { recursive: true });
  if (withFile) writeFileSync(join(root, "content", "rigs.local.json"), JSON.stringify(DOC));
  return root;
}
const file = (root: string): string => join(root, "content", "rigs.local.json");
const put = (root: string, doc: unknown) => handleRigRoute(root, "PUT", "/api/editor/rigs", JSON.stringify({ doc }));

describe("rig routes", () => {
  it("ignores other paths and unknown subpaths", () => {
    assert.equal(handleRigRoute("x", "GET", "/api/editor/scale", undefined), null);
    assert.equal(handleRigRoute("x", "GET", "/api/editor/rigs/x", undefined)?.status, 404);
  });
  it("GET answers the file, or the empty document when absent", () => {
    const root = fakeRepo();
    assert.deepEqual((handleRigRoute(root, "GET", "/api/editor/rigs", undefined)?.body as { doc: unknown }).doc, DOC);
    const bare = fakeRepo(false);
    assert.deepEqual((handleRigRoute(bare, "GET", "/api/editor/rigs", undefined)?.body as { doc: unknown }).doc, { version: 1, models: {} });
    rmSync(root, { recursive: true });
    rmSync(bare, { recursive: true });
  });
  it("PUT validates then writes, creating content/ if needed", () => {
    const root = fakeRepo(false);
    const next = { version: 1, models: { "demo/Wolf": { legTop: 0.4, inactive: ["tail"] } } };
    assert.equal(put(root, next)?.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(file(root), "utf8")), next);
    rmSync(root, { recursive: true });
  });
  it("a refused save answers 400 with issues and writes nothing", () => {
    const root = fakeRepo();
    const before = readFileSync(file(root), "utf8");
    const r = put(root, { version: 1, models: { "demo/Deer": { legTop: 9, headSign: 3 } } });
    assert.equal(r?.status, 400);
    assert.equal((r?.body as { issues: unknown[] }).issues.length, 2);
    assert.equal(readFileSync(file(root), "utf8"), before);
    assert.equal(put(root, undefined)?.status, 400);
    const bare = fakeRepo(false);
    put(bare, { version: 7 });
    assert.equal(existsSync(file(bare)), false);
    rmSync(root, { recursive: true });
    rmSync(bare, { recursive: true });
  });
  it("a corrupt file is a 500 that names the file, not a crash", () => {
    const root = fakeRepo();
    writeFileSync(file(root), "{ nope");
    const r = handleRigRoute(root, "GET", "/api/editor/rigs", undefined);
    assert.equal(r?.status, 500);
    assert.match((r?.body as { error: string }).error, /rigs\.local\.json/);
    rmSync(root, { recursive: true });
  });
});
