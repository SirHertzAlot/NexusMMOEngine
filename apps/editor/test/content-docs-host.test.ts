/**
 * Designer settings documents (EG1, EG3): GET reads the fixed file, PUT
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
import { CONTENT_DOC_KEYS } from "../src/content-docs-host.js";
import { CRAFTING_ROWS, CRAFTING_SECTIONS } from "../src/crafting-rules.js";
import { ENTRANCE_FIELDS, RUN_SECTIONS } from "../src/dungeon-rules.js";
import { VFX_BUDGET_SECTIONS } from "../src/vfx-budgets.js";
import { PERSISTENCE_SECTIONS, WORLD_SECTIONS } from "../src/server-settings.js";
import { getAt } from "../src/rules-control.js";

const REPO = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));
const ROOT = join(tmpdir(), `mmo-docs-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
const disk = (name: keyof typeof CONTENT_DOC_FILES): unknown => JSON.parse(readFileSync(join(ROOT, "content", CONTENT_DOC_FILES[name]), "utf8"));
const route = (method: string, name: string, content?: unknown) =>
  handleContentDocsRoute(ROOT, method, `/api/editor/docs/${name}`, content === undefined ? undefined : JSON.stringify({ content }));

before(() => {
  mkdirSync(join(ROOT, "content"), { recursive: true });
  cpSync(join(REPO, "content", "dungeons"), join(ROOT, "content", "dungeons"), { recursive: true });
  cpSync(join(REPO, "content", "crafting"), join(ROOT, "content", "crafting"), { recursive: true });
  cpSync(join(REPO, "content", "vfx"), join(ROOT, "content", "vfx"), { recursive: true });
  cpSync(join(REPO, "content", "server"), join(ROOT, "content", "server"), { recursive: true });
  // The schemas are read from <root>/packages/engine-core/dist: borrow the real build.
  mkdirSync(join(ROOT, "packages"), { recursive: true });
  symlinkSync(join(REPO, "packages", "engine-core"), join(ROOT, "packages", "engine-core"), "junction");
  symlinkSync(join(REPO, "packages", "crafting"), join(ROOT, "packages", "crafting"), "junction");
  symlinkSync(join(REPO, "packages", "art"), join(ROOT, "packages", "art"), "junction");
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

describe("crafting rules document", () => {
  it("PUT replaces only the form's keys, keeping refining and reagents as on disk", async () => {
    const before = disk("crafting") as Record<string, unknown>;
    // A stale refining section in the form's copy must not undo a Data grids save.
    const next = { ...before, refining: {}, defaultUnits: 5, units: [{ tags: ["jewel"], units: 2 }], skills: [{ tags: ["wood"], skill: "Carving" }] };
    const r = await route("PUT", "crafting", next);
    assert.equal(r?.status, 200);
    assert.deepEqual(disk("crafting"), { ...before, defaultUnits: 5, units: [{ tags: ["jewel"], units: 2 }], skills: [{ tags: ["wood"], skill: "Carving" }] });
  });

  it("PUT refuses unknown materials and bad rows by field, and writes nothing", async () => {
    const before = disk("crafting") as Record<string, unknown>;
    const bad = { ...before, runeStone: "moon-cheese", fittings: [{ tags: [], add: { "beast-hide": 2 } }], defaultUnits: 0 };
    const r = await route("PUT", "crafting", bad);
    assert.equal(r?.status, 400);
    const paths = (r?.body as { issues: Array<{ file: string; path: string }> }).issues.map((i) => i.path);
    assert.ok(paths.includes("fittings.0.tags"), paths.join());
    assert.ok(paths.includes("defaultUnits"), paths.join());
    assert.deepEqual(disk("crafting"), before);
    // Shape first: once the shape is fine the material check names the rune stone.
    const r2 = await route("PUT", "crafting", { ...before, runeStone: "moon-cheese" });
    assert.deepEqual((r2?.body as { issues: Array<{ path: string }> }).issues.map((i) => i.path), ["runeStone"]);
  });

  it("the form covers every key it owns", () => {
    const covered = [...CRAFTING_SECTIONS.flatMap((s) => s.fields.map((f) => f.key)), ...CRAFTING_ROWS.map((r) => r.under)].sort();
    assert.deepEqual(covered, [...(CONTENT_DOC_KEYS.crafting ?? [])].sort());
    const file = Object.keys(JSON.parse(readFileSync(join(REPO, "content", "crafting", "recipes.json"), "utf8")) as object)
      .filter((k) => !["version", "refining", "reagents"].includes(k))
      .sort();
    assert.deepEqual(covered, file);
  });
});

describe("particle budgets document (EG10)", () => {
  it("PUT writes valid budgets and refuses a tier below the one under it, writing nothing", async () => {
    const before = disk("vfxBudgets") as { tiers: Record<string, { maxParticles: number; maxEmitters: number }> };
    const next = structuredClone(before);
    next.tiers.low.maxParticles = 800;
    assert.equal((await route("PUT", "vfxBudgets", next))?.status, 200);
    assert.deepEqual(disk("vfxBudgets"), next);
    const bad = structuredClone(next);
    bad.tiers.high.maxParticles = 10;
    bad.tiers.medium.maxEmitters = 0;
    const r = await route("PUT", "vfxBudgets", bad);
    assert.equal(r?.status, 400);
    const issues = (r?.body as { issues: Array<{ file: string; path: string }> }).issues;
    assert.ok(issues.some((i) => i.path === "tiers.medium.maxEmitters"), JSON.stringify(issues));
    assert.deepEqual(disk("vfxBudgets"), next);
  });

  it("the form covers every tier's caps, with the built-in budgets as placeholders", () => {
    const keys = VFX_BUDGET_SECTIONS.flatMap((s) => s.fields.map((f) => f.key)).sort();
    const file = JSON.parse(readFileSync(join(REPO, "content", "vfx", "budgets.json"), "utf8")) as { tiers: Record<string, Record<string, number>> };
    assert.deepEqual(keys, Object.entries(file.tiers).flatMap(([t, b]) => Object.keys(b).map((k) => `tiers.${t}.${k}`)).sort());
    for (const f of VFX_BUDGET_SECTIONS.flatMap((s) => s.fields)) assert.equal(f.def, getAt(file, f.key), f.key);
  });
});

describe("server persistence settings (EG13)", () => {
  it("PUT writes valid settings and refuses bad ones by field, writing nothing", async () => {
    const next = { ...(disk("persistence") as Record<string, unknown>), saveEverySeconds: 30, keepSnapshots: 12 };
    assert.equal((await route("PUT", "persistence", next))?.status, 200);
    assert.deepEqual(disk("persistence"), next);
    const r = await route("PUT", "persistence", { ...next, keepSnapshots: 0, queryDefaultRows: 9000 });
    assert.equal(r?.status, 400);
    const paths = (r?.body as { issues: Array<{ path: string }> }).issues.map((i) => i.path);
    assert.ok(paths.includes("keepSnapshots"), paths.join());
    assert.deepEqual(disk("persistence"), next);
  });

  it("the form covers every setting, with the server's defaults as placeholders", () => {
    const fields = PERSISTENCE_SECTIONS.flatMap((s) => s.fields);
    const file = JSON.parse(readFileSync(join(REPO, "content", "server", "persistence.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(fields.map((f) => f.key).sort(), Object.keys(file).sort());
    for (const f of fields) assert.equal(f.def, file[f.key], f.key);
  });
});

describe("server world settings (EG14)", () => {
  it("PUT writes valid settings and refuses bad ones by field, writing nothing", async () => {
    const base = disk("world") as { bots: Record<string, unknown> };
    const next = { ...base, daySeconds: 900, bots: { ...base.bots, count: 6, home: [120, -40] } };
    assert.equal((await route("PUT", "world", next))?.status, 200);
    assert.deepEqual(disk("world"), next);
    const r = await route("PUT", "world", { ...next, dayOffset: 2, bots: { ...next.bots, radiusM: -1 } });
    assert.equal(r?.status, 400);
    const paths = (r?.body as { issues: Array<{ path: string }> }).issues.map((i) => i.path);
    assert.ok(paths.includes("dayOffset") && paths.includes("bots.radiusM"), paths.join());
    assert.deepEqual(disk("world"), next);
    assert.equal((await route("PUT", "world", base))?.status, 200);
  });

  it("the form covers every setting, with the server's defaults as placeholders", () => {
    const file = JSON.parse(readFileSync(join(REPO, "content", "server", "world.json"), "utf8")) as Record<string, unknown>;
    const fields = WORLD_SECTIONS.flatMap((s) => s.fields);
    const leaves = Object.entries(file).flatMap(([k, v]) => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).map((c) => `${k}.${c}`) : [k]));
    assert.deepEqual(fields.map((f) => f.key).sort(), leaves.sort());
    for (const f of fields) assert.equal(f.def, getAt(file, f.key), f.key);
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
