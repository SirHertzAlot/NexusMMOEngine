/**
 * The Blender live link (docs/BLENDER-LINK.md, slice EU10).
 *
 * This is the one route in the editor that writes binary from outside
 * the browser, so the assertions are mostly about what it refuses: a
 * name that is not a plain identifier never reaches the filesystem, a
 * body that is not a model never reaches a rename, and a push that is
 * cut off leaves nothing behind for the editor to load.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAX_BYTES,
  liveModelFile,
  liveModelUrl,
  mb,
  recordPush,
  refuseModel,
  sinceLabel,
  type LiveIndex,
} from "../src/blender-link.js";
import { handleBlenderRoute, isGlb, readIndex, receivePush } from "../src/blender-host.js";
import { BlenderLinkView, modelLine } from "../src/ui/blender-panel.js";

/** A minimal glTF binary header: magic, version 2, length. */
const glb = (payload = "model-bytes"): Uint8Array => {
  const body = Buffer.from(payload, "utf8");
  const head = Buffer.alloc(12);
  head.write("glTF", 0, "ascii");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + body.length, 8);
  return new Uint8Array(Buffer.concat([head, body]));
};

async function* stream(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield c;
}

describe("which pushes are accepted", () => {
  it("accepts a plain model name", () => {
    for (const name of ["hero", "oak-tree", "rock_02", "a"]) assert.equal(refuseModel(name, 10), null, name);
  });

  it("refuses a name that could name a path", () => {
    for (const name of ["../hero", "a/b", "C:/x", ".hidden", "", "HERO", "héros", "x".repeat(65)]) {
      assert.ok(refuseModel(name, 10), name);
    }
  });

  it("refuses an empty export and one over the limit", () => {
    assert.match(refuseModel("hero", 0) ?? "", /empty/);
    assert.match(refuseModel("hero", MAX_BYTES + 1) ?? "", /exceeds/);
    assert.equal(refuseModel("hero", MAX_BYTES), null);
  });

  it("puts every model in the one ignored folder", () => {
    assert.equal(liveModelFile("hero"), "assets/live/hero.glb");
    // The version is in the URL, so a re-push is not served from cache.
    assert.match(liveModelUrl("hero", 1764160000000), /^\/assets\/live\/hero\.glb\?v=1764160000000$/);
  });

  it("recognises a glTF binary header, and only that", () => {
    assert.ok(isGlb(glb()));
    assert.ok(!isGlb(new Uint8Array(Buffer.from("not a model at all", "utf8"))));
    assert.ok(!isGlb(new Uint8Array(Buffer.from("glTF", "utf8"))), "a truncated header is not a model");
  });
});

describe("the index", () => {
  const base: LiveIndex = { models: [] };

  it("keeps the newest push first and counts repeats", () => {
    const one = recordPush(base, { name: "hero", bytes: 10, at: 1 });
    const two = recordPush(one, { name: "tree", bytes: 20, at: 2 });
    const three = recordPush(two, { name: "hero", bytes: 30, at: 3 });
    assert.deepEqual(three.models.map((m) => m.name), ["hero", "tree"]);
    assert.equal(three.models[0].pushes, 2);
    assert.equal(three.models[0].bytes, 30);
    assert.equal(three.models[1].pushes, 1);
  });
});

describe("receiving a push", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "blender-link-"));
  });

  const live = (): string[] => {
    const dir = join(root, "assets", "live");
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  };

  it("writes the model and records it", async () => {
    const model = await receivePush(root, "hero", stream(glb("abc")), "hero.blend", 1000);
    assert.equal(model.name, "hero");
    assert.equal(model.pushes, 1);
    assert.equal(model.from, "hero.blend");
    assert.deepEqual(live(), ["hero.glb", "index.json"]);
    assert.equal(readIndex(root).models[0].name, "hero");
  });

  it("replaces the file on the next push, without a second entry", async () => {
    await receivePush(root, "hero", stream(glb("one")), undefined, 1000);
    await receivePush(root, "hero", stream(glb("two-longer")), undefined, 2000);
    const index = readIndex(root);
    assert.equal(index.models.length, 1);
    assert.equal(index.models[0].pushes, 2);
    assert.match(readFileSync(join(root, "assets", "live", "hero.glb"), "utf8"), /two-longer/);
  });

  it("takes a model arriving in pieces, as a socket delivers it", async () => {
    const whole = glb("chunked-body");
    await receivePush(root, "hero", stream(whole.slice(0, 4), whole.slice(4, 14), whole.slice(14)), undefined, 1);
    assert.equal(readIndex(root).models[0].bytes, whole.length);
  });

  it("refuses a name that could name a path, before opening anything", async () => {
    await assert.rejects(() => receivePush(root, "../escape", stream(glb()), undefined, 1));
    assert.deepEqual(live(), []);
  });

  it("refuses a body that is not a model, and leaves nothing behind", async () => {
    await assert.rejects(
      () => receivePush(root, "hero", stream(new Uint8Array(Buffer.from("<html>not a model</html>"))), undefined, 1),
      /not a glTF binary/,
    );
    assert.deepEqual(live().filter((f) => !f.startsWith(".")), []);
  });

  it("leaves no half-written model when the export is cut off", async () => {
    async function* cut(): AsyncGenerator<Uint8Array> {
      yield glb("start");
      throw new Error("blender went away");
    }
    await assert.rejects(() => receivePush(root, "hero", cut(), undefined, 1));
    assert.ok(!existsSync(join(root, "assets", "live", "hero.glb")));
    assert.deepEqual(live().filter((f) => !f.startsWith(".")), []);
  });

  it("forgets a model whose file someone deleted by hand", async () => {
    await receivePush(root, "hero", stream(glb()), undefined, 1);
    rmSync(join(root, "assets", "live", "hero.glb"));
    assert.deepEqual(readIndex(root).models, []);
  });

  it("reads an index that is not there, or is corrupt, as empty", () => {
    assert.deepEqual(readIndex(root).models, []);
    mkdirSync(join(root, "assets", "live"), { recursive: true });
    writeFileSync(join(root, "assets", "live", "index.json"), "{ not json");
    assert.deepEqual(readIndex(root).models, []);
  });
});

describe("the route", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "blender-route-"));
  });

  it("ignores every URL but its own", async () => {
    assert.equal(await handleBlenderRoute(root, "GET", "/api/editor/code", new URLSearchParams(), undefined), null);
  });

  it("reports where models land and where the add-on is", async () => {
    const reply = await handleBlenderRoute(root, "GET", "/api/editor/blender", new URLSearchParams(), undefined);
    assert.equal(reply?.status, 200);
    const body = reply?.body as { dir: string; addon: string; models: unknown[] };
    assert.equal(body.dir, "assets/live");
    assert.match(body.addon, /mmo_live_link\.py$/);
    assert.deepEqual(body.models, []);
  });

  it("accepts a push and answers with the model", async () => {
    const reply = await handleBlenderRoute(
      root,
      "POST",
      "/api/editor/blender/push",
      new URLSearchParams({ name: "hero", from: "hero.blend" }),
      stream(glb()),
    );
    assert.equal(reply?.status, 200);
    assert.equal((reply?.body as { model: { name: string } }).model.name, "hero");
  });

  it("answers a refused name with 400 and the reason", async () => {
    const reply = await handleBlenderRoute(
      root,
      "POST",
      "/api/editor/blender/push",
      new URLSearchParams({ name: "../x" }),
      stream(glb()),
    );
    assert.equal(reply?.status, 400);
    assert.match(String((reply?.body as { error: string }).error), /lower-case letters/);
  });
});

describe("the panel", () => {
  const now = Date.UTC(2026, 10, 26, 12, 0, 0);

  it("tells you how to install the add-on when nothing has arrived", () => {
    const html = renderToStaticMarkup(
      React.createElement(BlenderLinkView, {
        link: { dir: "assets/live", addon: "scripts/blender/mmo_live_link.py", models: [] },
        now,
      }),
    );
    assert.match(html, /nothing received yet/);
    assert.match(html, /mmo_live_link\.py/);
    assert.match(html, /gitignored/);
  });

  it("says the host is not serving it, rather than showing an empty list", () => {
    const html = renderToStaticMarkup(React.createElement(BlenderLinkView, { link: null, now }));
    assert.match(html, /not serving/);
  });

  it("lines up size, age and where it came from", () => {
    assert.equal(
      modelLine({ name: "hero", bytes: 2 * 1024 * 1024, at: now - 120_000, pushes: 3, from: "hero.blend" }, now),
      "2.0 MB · 2 min ago · 3 pushes · hero.blend",
    );
    assert.equal(modelLine({ name: "x", bytes: 4096, at: now, pushes: 1 }, now), "4 KB · just now");
  });

  it("reads a size and an age the way a person would", () => {
    assert.equal(mb(1536), "2 KB");
    assert.equal(mb(5 * 1024 * 1024), "5.0 MB");
    assert.equal(sinceLabel(now - 10_000, now), "just now");
    assert.equal(sinceLabel(now - 7200_000, now), "2 h ago");
  });
});
