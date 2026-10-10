/**
 * Audio host (EA24): reads content/audio/events.json, validates a save with
 * the server's own AudioBank schema, writes only valid documents. Writes go
 * to a throwaway repo root, never the real content.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleAudioRoute } from "../src/audio-host.js";

const REPO = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));
const ROOT = join(tmpdir(), `mmo-audio-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
const disk = (): string => readFileSync(join(ROOT, "content", "audio", "events.json"), "utf8");
const save = (content: unknown) => handleAudioRoute(ROOT, "POST", "/api/editor/audio/save", async () => JSON.stringify({ content }));

before(() => {
  mkdirSync(join(ROOT, "content"), { recursive: true });
  cpSync(join(REPO, "content", "audio"), join(ROOT, "content", "audio"), { recursive: true });
  // The schema is read from <root>/packages/engine-core/dist: borrow the real build.
  mkdirSync(join(ROOT, "packages"), { recursive: true });
  symlinkSync(join(REPO, "packages", "engine-core"), join(ROOT, "packages", "engine-core"), "junction");
});
after(() => rmSync(ROOT, { recursive: true, force: true }));

describe("audio routes", () => {
  it("ignores other paths", async () => {
    assert.equal(await handleAudioRoute(ROOT, "GET", "/api/editor/flow", async () => ""), null);
  });

  it("GET returns the document", async () => {
    const r = await handleAudioRoute(ROOT, "GET", "/api/editor/audio", async () => "");
    assert.equal(r?.status, 200);
    const content = (r?.body as { content: { events: { name: string }[] } }).content;
    assert.ok(content.events.some((e) => e.name === "hit"));
  });

  it("saves a valid edit, readable again", async () => {
    const doc = JSON.parse(disk()) as { buses: Record<string, { gain: number }>; events: unknown[] };
    doc.buses.combat!.gain = 0.5;
    const r = await save(doc);
    assert.equal(r?.status, 200);
    assert.equal((JSON.parse(disk()) as typeof doc).buses.combat!.gain, 0.5);
  });

  it("refuses an invalid document with every issue and writes nothing", async () => {
    const before = disk();
    const bad = { events: [{ name: "x", bus: "nope", file: "x.ogg" }, { name: "y", bus: "combat" }] };
    const r = await save(bad);
    assert.equal(r?.status, 400);
    const body = r?.body as { ok: boolean; error: string; issues: { path: string }[] };
    assert.equal(body.ok, false);
    assert.ok(body.issues.length >= 2);
    assert.match(body.error, /invalid audio/);
    assert.match(body.error, /events\.0\.bus/);
    assert.equal(disk(), before);
  });

  it("refuses a duplicate event name", async () => {
    const e = { name: "a", bus: "combat", file: "a.ogg" };
    const r = await save({ events: [e, e] });
    assert.equal(r?.status, 400);
    assert.match((r?.body as { error: string }).error, /duplicate/);
  });

  it("refuses a body that is not JSON or has no content", async () => {
    assert.equal((await handleAudioRoute(ROOT, "POST", "/api/editor/audio/save", async () => "{"))?.status, 400);
    assert.equal((await handleAudioRoute(ROOT, "POST", "/api/editor/audio/save", async () => "{}"))?.status, 400);
  });
});
