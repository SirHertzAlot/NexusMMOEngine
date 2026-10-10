/**
 * play-setup: persisted Play menu choices (last + saved), their schema, and
 * what the start path honors. Storage is injected (fake here); the UI passes
 * window.localStorage.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bindSetupShortcut,
  botsCount,
  clientCount,
  defaultPlaySetup,
  loadLastSetup,
  loadSavedSetups,
  fromNodeId,
  setupsFromDoc,
  setupsToDoc,
  useEdge,
  normalizePlaySetup,
  persistSavedSetups,
  removeSavedSetup,
  saveLastSetup,
  setupDetail,
  setupSummary,
  upsertSavedSetup,
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

describe("play-setup", () => {
  it("defaults match the menu's initial choices", () => {
    assert.deepEqual(defaultPlaySetup(), {
      where: "viewport",
      from: "World",
      clients: "1",
      bots: "10",
      net: "Core only",
      latency: "0",
      fresh: true,
      keep: false,
      tint: true,
    });
  });

  it("normalize keeps good fields, defaults the rest", () => {
    const s = normalizePlaySetup({ where: "window", clients: "8", fresh: false, bogus: 1 });
    assert.equal(s.where, "window");
    assert.equal(s.clients, "8");
    assert.equal(s.fresh, false);
    assert.equal(s.from, "World");
    assert.equal(s.tint, true);
  });

  it("normalize rejects non-objects and empties", () => {
    for (const raw of [null, undefined, 42, "x", [], { where: "", clients: 8 }]) {
      assert.deepEqual(normalizePlaySetup(raw), defaultPlaySetup(), JSON.stringify(raw));
    }
  });

  it("the schema bounds clients to 1..8 and bots to 0..2000, field by field", () => {
    assert.equal(normalizePlaySetup({ clients: "3" }).clients, "3");
    assert.equal(normalizePlaySetup({ clients: "9" }).clients, "1");
    assert.equal(normalizePlaySetup({ clients: "0" }).clients, "1");
    assert.equal(normalizePlaySetup({ bots: "2000" }).bots, "2000");
    assert.equal(normalizePlaySetup({ bots: "2001", clients: "8" }).bots, "10");
    assert.equal(normalizePlaySetup({ bots: "-5" }).bots, "10");
    assert.equal(normalizePlaySetup({ where: "moon", from: "Camera position" }).where, "viewport");
    assert.equal(normalizePlaySetup({ where: "moon", from: "Camera position" }).from, "Camera position");
    assert.equal(normalizePlaySetup({ latency: "80 ms" }).latency, "80 ms");
    assert.equal(normalizePlaySetup({ latency: "slow" }).latency, "0");
    assert.equal(clientCount({ ...defaultPlaySetup(), clients: "3" }), 3);
    assert.equal(clientCount({ ...defaultPlaySetup(), clients: "99" }), 1);
  });

  it("last setup round-trips through storage", () => {
    const st = fakeStorage();
    assert.deepEqual(loadLastSetup(st), defaultPlaySetup());
    const s: PlaySetup = { ...defaultPlaySetup(), where: "simulate", bots: "50", keep: true };
    saveLastSetup(s, st);
    assert.deepEqual(loadLastSetup(st), s);
  });

  it("corrupt stored JSON falls back to defaults", () => {
    const st = fakeStorage();
    st.setItem("mmo-editor.play-last", "{nope");
    assert.deepEqual(loadLastSetup(st), defaultPlaySetup());
    st.setItem("mmo-editor.play-setups", "[1,2");
    assert.deepEqual(loadSavedSetups(st), []);
  });

  it("saved setups save, overwrite, persist and delete by name", () => {
    const st = fakeStorage();
    const raid: PlaySetup = { ...defaultPlaySetup(), clients: "8", bots: "50" };
    let all = upsertSavedSetup([], "Raid test", raid);
    all = upsertSavedSetup(all, "  ", raid);
    assert.deepEqual(all.map((s) => s.name), ["Raid test"]);
    all = upsertSavedSetup(all, "Solo", defaultPlaySetup());
    all = upsertSavedSetup(all, "Raid test", { ...raid, bots: "200" });
    persistSavedSetups(all, st);
    const back = loadSavedSetups(st);
    assert.deepEqual(back.map((s) => s.name), ["Raid test", "Solo"]);
    assert.equal(back[0]!.setup.bots, "200");
    assert.deepEqual(removeSavedSetup(removeSavedSetup(back, "Raid test"), "missing").map((s) => s.name), ["Solo"]);
  });

  it("a saved setup keeps its key through storage and overwrites", () => {
    const st = fakeStorage();
    let all = upsertSavedSetup([], "Raid", { ...defaultPlaySetup(), clients: "8", bots: "50" });
    const bound = bindSetupShortcut(all, "Raid", "alt+1");
    assert.equal(bound.error, null);
    all = upsertSavedSetup(bound.all, "Raid", { ...defaultPlaySetup(), clients: "8", bots: "60" });
    persistSavedSetups(all, st);
    assert.equal(loadSavedSetups(st)[0]!.shortcut, "Alt+1");
    assert.equal(loadSavedSetups(st)[0]!.setup.bots, "60");
  });

  it("binding refuses reserved, bare and duplicate keys, and clears with null", () => {
    let all = upsertSavedSetup(upsertSavedSetup([], "A", defaultPlaySetup()), "B", defaultPlaySetup());
    all = bindSetupShortcut(all, "A", "Alt+2").all;
    assert.match(bindSetupShortcut(all, "B", "Alt+2").error ?? "", /already starts “A”/);
    assert.match(bindSetupShortcut(all, "B", "F5").error ?? "", /taken by the editor/);
    assert.match(bindSetupShortcut(all, "B", "W").error ?? "", /Alt/);
    assert.match(bindSetupShortcut(all, "B", "nonsense").error ?? "", /not a key/);
    assert.equal(bindSetupShortcut(all, "A", "Alt+2").error, null);
    assert.equal(bindSetupShortcut(all, "A", null).all[0]!.shortcut, null);
  });

  it("stored keys that break the rules or repeat are dropped on load", () => {
    const st = fakeStorage();
    st.setItem("mmo-editor.play-setups", JSON.stringify({ A: { shortcut: "Alt+3" }, B: { shortcut: "alt+3" }, C: { shortcut: "F5" }, D: { shortcut: 7 } }));
    assert.deepEqual(loadSavedSetups(st).map((s) => s.shortcut), ["Alt+3", null, null, null]);
  });

  it("the old name-to-setup storage still loads", () => {
    const st = fakeStorage();
    st.setItem("mmo-editor.play-setups", JSON.stringify({ Old: { ...defaultPlaySetup(), clients: "4" } }));
    const [o] = loadSavedSetups(st);
    assert.equal(o!.name, "Old");
    assert.equal(o!.setup.clients, "4");
    assert.equal(o!.shortcut, null);
  });

  it("botsCount parses the menu's string options", () => {
    assert.equal(botsCount({ ...defaultPlaySetup(), bots: "200" }), 200);
    assert.equal(botsCount({ ...defaultPlaySetup(), bots: "0" }), 0);
    assert.equal(botsCount({ ...defaultPlaySetup(), bots: "many" }), 0);
  });

  it("setupSummary feeds the toolbar chip and setupDetail the saved list", () => {
    assert.equal(setupSummary(defaultPlaySetup()), "In viewport · World · 1 client");
    assert.equal(setupSummary({ ...defaultPlaySetup(), where: "window", clients: "8" }), "New window · World · 8 clients");
    assert.equal(setupDetail({ ...defaultPlaySetup(), clients: "8", bots: "50" }), "8 clients · 50 bots");
    assert.equal(setupDetail({ ...defaultPlaySetup(), latency: "80 ms", where: "simulate" }), "1 client · 10 bots · 80 ms · simulate");
  });

  it("Edge + core starts the edge; core only does not", () => {
    assert.equal(useEdge({ ...defaultPlaySetup(), net: "Core only" }), false);
    assert.equal(useEdge({ ...defaultPlaySetup(), net: "Edge + core" }), true);
  });

  it("a start choice names a flow node", () => {
    assert.equal(fromNodeId("Character creation"), "character-creation");
    assert.equal(fromNodeId("character-select"), "character-select");
    assert.equal(fromNodeId("Camera position"), "world");
    assert.equal(normalizePlaySetup({ from: "character-select" }).from, "character-select");
  });

  it("saved setups round-trip through the repo document, dropping entries that fail today's rules", () => {
    const all = [
      { name: "Raid", setup: { ...defaultPlaySetup(), clients: "8" }, shortcut: "F6" },
      { name: "Quick", setup: defaultPlaySetup(), shortcut: null },
    ];
    assert.deepEqual(setupsFromDoc(setupsToDoc(all)), all);
    const dup = setupsFromDoc({ version: 1, setups: [{ name: "A", shortcut: "F6", setup: {} }, { name: "B", shortcut: "F6", setup: {} }, { name: "A", setup: {} }] });
    assert.deepEqual(dup.map((s) => [s.name, s.shortcut]), [["A", "F6"], ["B", null]]);
    assert.deepEqual(setupsFromDoc(null), []);
  });
});
