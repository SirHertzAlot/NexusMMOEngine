/** Play host (EA14): saved setups route (a refused save writes nothing) and the start-body parser. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePlayRoute, parsePlayStart, setupsFile } from "../src/play-host.js";
import { defaultPlaySetup } from "../src/play-setups.js";

const URL_ = "/api/editor/play/setups";
const good = { version: 1, setups: [{ name: "Raid", shortcut: "F6", setup: { ...defaultPlaySetup(), clients: "8", bots: "50" } }] };

describe("play setups route", () => {
  it("ignores other paths", () => {
    assert.equal(handlePlayRoute("x", "GET", "/api/editor/flow", undefined), null);
  });

  it("GET is an empty document before anything is saved; PUT saves; GET returns it", () => {
    const root = mkdtempSync(join(tmpdir(), "mmo-play-host-"));
    assert.deepEqual((handlePlayRoute(root, "GET", URL_, undefined)?.body as { content: unknown }).content, { version: 1, setups: [] });
    const put = handlePlayRoute(root, "PUT", URL_, JSON.stringify({ content: good }));
    assert.equal(put?.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(setupsFile(root), "utf8")), good);
    assert.deepEqual((handlePlayRoute(root, "GET", URL_, undefined)?.body as { content: unknown }).content, good);
    rmSync(root, { recursive: true });
  });

  it("a refused save lists every problem and writes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "mmo-play-host-"));
    const bad = { version: 1, setups: [{ name: "x", shortcut: "F5", setup: { ...defaultPlaySetup(), clients: "99" } }] };
    const r = handlePlayRoute(root, "PUT", URL_, JSON.stringify({ content: bad }));
    assert.equal(r?.status, 400);
    assert.equal((r?.body as { issues: string[] }).issues.length, 2);
    assert.ok(!existsSync(setupsFile(root)));
    assert.equal(handlePlayRoute(root, "PUT", URL_, "not json")?.status, 400);
    assert.equal(handlePlayRoute(root, "PUT", URL_, JSON.stringify({ nope: 1 }))?.status, 400);
    rmSync(root, { recursive: true });
  });
});

describe("parsePlayStart", () => {
  it("reads the Play menu's options and drops anything out of range", () => {
    assert.deepEqual(parsePlayStart(JSON.stringify({ bots: 50, clients: 8, network: "edge", latencyMs: 80, fresh: true, keep: false })), {
      bots: 50, clients: 8, network: "edge", latencyMs: 80, fresh: true, keep: false,
    });
    assert.deepEqual(parsePlayStart(JSON.stringify({ bots: -1, clients: 9, latencyMs: 99999, network: "mesh", fresh: "yes" })), {});
    assert.deepEqual(parsePlayStart(""), {});
    assert.deepEqual(parsePlayStart("{nope"), {});
    assert.deepEqual(parsePlayStart("[]"), {});
  });
});
