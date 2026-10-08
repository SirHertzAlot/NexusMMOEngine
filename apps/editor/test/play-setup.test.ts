/**
 * play-setup: persisted Play menu choices (last + named), and what the
 * start path honors. Storage is injected (fake here); the UI passes
 * window.localStorage.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  botsCount,
  defaultPlaySetup,
  deleteNamedSetup,
  loadLastSetup,
  loadNamedSetups,
  normalizePlaySetup,
  PLAY_PREVIEW_NOTES,
  saveLastSetup,
  saveNamedSetup,
  setupSummary,
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
      net: "Edge + core",
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
    assert.deepEqual(loadNamedSetups(st), {});
  });

  it("named setups save, load and delete by name", () => {
    const st = fakeStorage();
    const raid: PlaySetup = { ...defaultPlaySetup(), clients: "8", bots: "200" };
    saveNamedSetup("Raid test", raid, st);
    saveNamedSetup("  ", raid, st);
    assert.deepEqual(loadNamedSetups(st), { "Raid test": raid });
    saveNamedSetup("Solo", defaultPlaySetup(), st);
    assert.deepEqual(Object.keys(loadNamedSetups(st)).sort(), ["Raid test", "Solo"]);
    deleteNamedSetup("Raid test", st);
    assert.deepEqual(Object.keys(loadNamedSetups(st)), ["Solo"]);
    deleteNamedSetup("missing", st);
    assert.deepEqual(Object.keys(loadNamedSetups(st)), ["Solo"]);
  });

  it("botsCount parses the menu's string options", () => {
    assert.equal(botsCount({ ...defaultPlaySetup(), bots: "200" }), 200);
    assert.equal(botsCount({ ...defaultPlaySetup(), bots: "0" }), 0);
    assert.equal(botsCount({ ...defaultPlaySetup(), bots: "many" }), 0);
  });

  it("setupSummary feeds the toolbar chip", () => {
    assert.equal(setupSummary(defaultPlaySetup()), "In viewport · World · 1 client");
    assert.equal(
      setupSummary({ ...defaultPlaySetup(), where: "window", clients: "8" }),
      "New window · World · 8 clients",
    );
  });

  it("preview notes cover every unhonored dimension", () => {
    for (const dim of ["where", "from", "clients", "net", "latency", "fresh", "keep"]) {
      assert.ok(PLAY_PREVIEW_NOTES[dim], dim);
    }
  });
});
