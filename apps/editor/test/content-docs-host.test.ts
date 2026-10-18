/**
 * Designer settings documents (EG1): GET reads the fixed file, PUT
 * validates with the game's own schema and writes only a valid document.
 * Writes go to a throwaway repo root, never the real content.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleContentDocsRoute } from "../src/content-docs-host.js";
import { CONTENT_DOC_FILES } from "../src/content-docs.js";
import { ENTRANCE_FIELDS, RUN_SECTIONS } from "../src/dungeon-rules.js";

const REPO = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));
const ROOT = join(tmpdir(), `mmo-docs-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
const disk = (name: keyof typeof CONTENT_DOC_FILES): unknown => JSON.parse(readFileSync(join(ROOT, "content", CONTENT_DOC_FILES[name]), "utf8"));
const route = (method: string, name: string, content?: unknown) =>
  handleContentDocsRoute(ROOT, method, `/api/editor/docs/${name}`, content === undefined ? undefined : JSON.stringify({ content }));

before(() => {
  mkdirSync(join(ROOT, "content"), { recursive: true });
  cpSync(join(REPO, "content", "dungeons"), join(ROOT, "content", "dungeons"), { recursive: true });
  // The schemas are read from <root>/packages/engine-core/dist: borrow the real build.
  mkdirSync(join(ROOT, "packages"), { recursive: true });
  symlinkSync(join(REPO, "packages", "engine-core"), join(ROOT, "packages", "engine-core"), "junction");
});
after(() => rmSync(ROOT, { recursive: true, force: true }));

describe("content docs routes", () => {
  it("ignores other paths and refuses unknown documents", async () => {
    assert.equal(await handleContentDocsRoute(ROOT, "GET", "/api/editor/scale", undefined), null);
    assert.equal((await route("GET", "..%2Frules%2Fbody"))?.status, 404);
    assert.equal((await route("GET", "toString"))?.status, 404);
  });

  it("GET returns the file as written", async () => {
    const r = await route("GET", "instances");
    assert.equal(r?.status, 200);
    assert.deepEqual((r?.body as { content: unknown }).content, disk("instances"));
  });

  it("PUT writes a valid document", async () => {
    const next = { ...(disk("instances") as Record<string, unknown>), timeLimitMinutes: 30, trapsPerRun: 4 };
    const r = await route("PUT", "instances", next);
    assert.equal(r?.status, 200);
    assert.deepEqual(disk("instances"), next);
  });

  it("PUT refuses an invalid document with every issue by field, and writes nothing", async () => {
    const before = disk("instances");
    const bad = { ...(before as Record<string, unknown>), partySize: [5, 2], trapHarm: 0 };
    const r = await route("PUT", "instances", bad);
    assert.equal(r?.status, 400);
    const issues = (r?.body as { issues: Array<{ file: string; path: string }> }).issues;
    assert.ok(issues.every((i) => i.file === "instances.json"));
    assert.ok(issues.some((i) => i.path === "partySize"));
    assert.ok(issues.some((i) => i.path === "trapHarm"));
    assert.deepEqual(disk("instances"), before);
  });

  it("PUT checks entrances with their own schema", async () => {
    const ok = { version: 1, entrances: { "north-crypt": { name: "North crypt", x: 10, z: -20, radius: 6, rank: 2, themes: ["crypt"] } } };
    assert.equal((await route("PUT", "entrances", ok))?.status, 200);
    const bad = { version: 1, entrances: { "Bad Id": { name: "", x: 0, z: 0, radius: 0, rank: null } } };
    const r = await route("PUT", "entrances", bad);
    assert.equal(r?.status, 400);
    assert.deepEqual(disk("entrances"), ok);
  });
});

describe("dungeon run form", () => {
  it("covers every run rule a designer can change", () => {
    const keys = RUN_SECTIONS.flatMap((s) => s.fields.map((f) => f.key)).sort();
    const file = Object.keys(JSON.parse(readFileSync(join(REPO, "content", "dungeons", "instances.json"), "utf8")) as object)
      .filter((k) => k !== "version" && k !== "commit")
      .sort();
    assert.deepEqual(keys, file);
  });

  it("covers every entrance field", () => {
    assert.deepEqual(ENTRANCE_FIELDS.map((f) => f.key).sort(), ["name", "radius", "rank", "themes", "x", "z"]);
  });
});
