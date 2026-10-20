/** Scale host: content/scale.json, validated saves, a refused save writes nothing. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleScaleRoute } from "../src/scale-host.js";

const DOC = { version: 1, global: 1, categories: { building: 0.6 }, assets: {} };
function fakeRepo(withFile = true): string {
  const root = join(tmpdir(), `mmo-scale-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  mkdirSync(join(root, "content"), { recursive: true });
  if (withFile) writeFileSync(join(root, "content", "scale.json"), JSON.stringify(DOC));
  return root;
}
const file = (root: string): string => join(root, "content", "scale.json");
const put = (root: string, doc: unknown) => handleScaleRoute(root, "PUT", "/api/editor/scale", JSON.stringify({ doc }));

describe("scale routes", () => {
  it("ignores other paths and unknown subpaths", () => {
    assert.equal(handleScaleRoute("x", "GET", "/api/editor/strings", undefined), null);
    assert.equal(handleScaleRoute("x", "GET", "/api/editor/scale/x", undefined)?.status, 404);
  });
  it("GET answers the file, or the default when absent", () => {
    const root = fakeRepo();
    assert.deepEqual((handleScaleRoute(root, "GET", "/api/editor/scale", undefined)?.body as { doc: unknown }).doc, DOC);
    const bare = fakeRepo(false);
    assert.equal((handleScaleRoute(bare, "GET", "/api/editor/scale", undefined)?.body as { doc: { global: number } }).doc.global, 1);
    rmSync(root, { recursive: true });
    rmSync(bare, { recursive: true });
  });
  it("PUT validates then writes", () => {
    const root = fakeRepo();
    const next = { ...DOC, global: 1.5, assets: { "pack/House*": 0.5 } };
    assert.equal(put(root, next)?.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(file(root), "utf8")), next);
    rmSync(root, { recursive: true });
  });
  it("a refused save answers 400 with issues and writes nothing", () => {
    const root = fakeRepo();
    const before = readFileSync(file(root), "utf8");
    const r = put(root, { ...DOC, global: 999, categories: { sofa: 1 } });
    assert.equal(r?.status, 400);
    assert.equal((r?.body as { issues: unknown[] }).issues.length, 2);
    assert.equal(readFileSync(file(root), "utf8"), before);
    assert.equal(put(root, undefined)?.status, 400);
    rmSync(root, { recursive: true });
  });
});
