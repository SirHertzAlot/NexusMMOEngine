/**
 * play-setup (EA14): the Play menu's setup, its validation, the saved-setups
 * document with shortcut keys, and the last-used setup in storage (a fake here;
 * the UI passes window.localStorage).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  botsCount,
  checkPlaySetup,
  clientCount,
  defaultPlaySetup,
  emptySetups,
  fetchPlaySetups,
  latencyMs,
  loadLastSetup,
  normalizePlaySetup,
  saveLastSetup,
  savePlaySetups,
  setupForKey,
  setupSummary,
  useEdge,
  validatePlaySetups,
  withoutSetup,
  withSetup,
  type PlaySetup,
  type PlayStorage,
} from "../src/ui/play-setup.js";

function fakeStorage(): PlayStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}
const key = (k: string, alt = false) => ({ key: k, altKey: alt, ctrlKey: false, metaKey: false, shiftKey: false });

describe("play-setup", () => {
  it("defaults match the menu's initial choices and are valid", () => {
    assert.deepEqual(defaultPlaySetup(), {
      where: "viewport",
      from: "world",
      clients: "1",
      bots: "10",
      net: "Edge + core",
      latency: "0",
      fresh: true,
      keep: false,
      tint: true,
    });
    assert.deepEqual(checkPlaySetup(defaultPlaySetup()), []);
  });

  it("normalize keeps good fields, defaults the rest, maps the old node labels", () => {
    const s = normalizePlaySetup({ where: "window", clients: "8", fresh: false, from: "Character creation", latency: "9 ms", bogus: 1 });
    assert.equal(s.where, "window");
    assert.equal(s.clients, "8");
    assert.equal(s.fresh, false);
    assert.equal(s.from, "character-creation");
    assert.equal(s.latency, "0");
    assert.equal(s.tint, true);
  });

  it("normalize rejects non-objects, empties and out-of-range values", () => {
    for (const raw of [null, undefined, 42, "x", [], { where: "", clients: 8 }, { clients: "9" }, { where: "tv" }]) {
      assert.deepEqual(normalizePlaySetup(raw), defaultPlaySetup(), JSON.stringify(raw));
    }
  });

  it("last setup round-trips through storage", () => {
    const st = fakeStorage();
    assert.deepEqual(loadLastSetup(st), defaultPlaySetup());
    const s: PlaySetup = { ...defaultPlaySetup(), where: "simulate", bots: "50", keep: true };
    saveLastSetup(s, st);
    assert.deepEqual(loadLastSetup(st), s);
    st.setItem("mmo-editor.play-last", "{nope");
    assert.deepEqual(loadLastSetup(st), defaultPlaySetup());
  });

  it("the menu's strings parse into what the host is told", () => {
    const s = { ...defaultPlaySetup(), bots: "200", clients: "8", latency: "80 ms", net: "Core only" };
    assert.equal(botsCount(s), 200);
    assert.equal(clientCount(s), 8);
    assert.equal(latencyMs(s), 80);
    assert.equal(useEdge(s), false);
    assert.equal(botsCount({ ...s, bots: "many" }), 0);
    assert.equal(clientCount({ ...s, clients: "x" }), 1);
    assert.equal(latencyMs({ ...s, latency: "0" }), 0);
  });

  it("setupSummary feeds the toolbar chip", () => {
    assert.equal(setupSummary({ ...defaultPlaySetup(), bots: "0" }), "In viewport · world · 1 client · edge + core");
    assert.equal(
      setupSummary({ ...defaultPlaySetup(), where: "window", clients: "8", bots: "50", net: "Core only", latency: "200 ms", from: "@camera" }),
      "New window · camera · 8 clients · 50 bots · core only · 200 ms",
    );
  });
});

describe("saved play setups", () => {
  const raid: PlaySetup = { ...defaultPlaySetup(), clients: "8", bots: "200" };

  it("withSetup adds, replaces in place and moves a key to its newest owner", () => {
    let doc = withSetup(emptySetups(), "Raid", raid, "F6");
    doc = withSetup(doc, "Solo", defaultPlaySetup(), "F7");
    assert.deepEqual(doc.setups.map((s) => [s.name, s.shortcut]), [["Raid", "F6"], ["Solo", "F7"]]);
    doc = withSetup(doc, "Solo", defaultPlaySetup(), "F6");
    assert.deepEqual(doc.setups.map((s) => [s.name, s.shortcut]), [["Raid", undefined], ["Solo", "F6"]]);
    // Re-saving without a key argument keeps the key.
    doc = withSetup(doc, "Solo", raid);
    assert.equal(doc.setups[1].shortcut, "F6");
    assert.equal(doc.setups[1].setup.clients, "8");
    assert.deepEqual(validatePlaySetups(doc), []);
    assert.deepEqual(withoutSetup(doc, "Raid").setups.map((s) => s.name), ["Solo"]);
  });

  it("a key press finds its setup: F6, Alt+3, never F5 or a modified key", () => {
    const doc = withSetup(withSetup(emptySetups(), "Raid", raid, "F6"), "Duo", { ...raid, clients: "2" }, "Alt+3");
    assert.equal(setupForKey(doc, key("F6"))?.name, "Raid");
    assert.equal(setupForKey(doc, key("3", true))?.name, "Duo");
    assert.equal(setupForKey(doc, key("F5")), null);
    assert.equal(setupForKey(doc, key("F7")), null);
    assert.equal(setupForKey(doc, { ...key("F6"), ctrlKey: true }), null);
    assert.equal(setupForKey(doc, { ...key("F6"), shiftKey: true }), null);
  });

  it("validation lists every problem", () => {
    const bad = {
      version: 1,
      setups: [
        { name: "", setup: raid },
        { name: "a", shortcut: "F5", setup: raid },
        { name: "b", shortcut: "F6", setup: { ...raid, clients: "9", net: "mesh" } },
        { name: "c", shortcut: "F6", setup: raid },
        { name: "b", setup: raid },
      ],
    };
    const issues = validatePlaySetups(bad).join("\n");
    for (const part of ["name must be", "shortcut must be one of", "clients", "net", "already bound", 'duplicate name "b"']) {
      assert.match(issues, new RegExp(part));
    }
    assert.deepEqual(validatePlaySetups({ version: 2, setups: [] }), ["version must be 1"]);
    assert.deepEqual(validatePlaySetups(null), ["document must be an object"]);
  });

  it("fetch and save talk to the host route and surface its refusal", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const ok = (async (u: string, init?: RequestInit) => {
      calls.push([u, init]);
      return { ok: true, status: 200, json: async () => ({ ok: true, content: withSetup(emptySetups(), "Raid", raid) }) };
    }) as unknown as typeof fetch;
    const doc = await fetchPlaySetups("", ok);
    assert.equal(doc.setups[0].name, "Raid");
    await savePlaySetups(doc, "", ok);
    assert.equal(calls[1][0], "/api/editor/play/setups");
    assert.equal(calls[1][1]?.method, "PUT");
    const refuse = (async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid play setups: 1 problem", issues: ["setups[0]: nope"] }) })) as unknown as typeof fetch;
    await assert.rejects(savePlaySetups(doc, "", refuse), /invalid play setups: 1 problem; setups\[0\]: nope/);
  });
});
