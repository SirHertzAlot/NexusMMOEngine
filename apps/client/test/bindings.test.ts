/**
 * Bindings (U4): defaults, rebind-with-steal, reset, and tolerant parsing.
 */

import "./i18n-setup.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BINDINGS,
  parseBindings,
  prettyCode,
  resetBindings,
  setBinding,
  type Bindings,
} from "../src/input/bindings.js";

const memStore = (): { getItem(k: string): string | null; setItem(k: string, v: string): void; data: Record<string, string> } => {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
};

describe("bindings", () => {
  it("rebinding steals the code from other actions", () => {
    const b = setBinding(structuredClone(DEFAULT_BINDINGS), "dodge", 0, "KeyW");
    assert.deepEqual(b.dodge, ["KeyW"]);
    assert.deepEqual(b.forward, ["ArrowUp"], "W stolen from forward");
  });

  it("rebinding a slot keeps the other slots", () => {
    const b = setBinding(structuredClone(DEFAULT_BINDINGS), "forward", 1, "KeyE");
    assert.deepEqual(b.forward, ["KeyW", "KeyE"]);
  });

  it("mouse codes are refused", () => {
    const before: Bindings = structuredClone(DEFAULT_BINDINGS);
    assert.equal(setBinding(before, "dodge", 0, "Mouse0"), before);
  });

  it("reset restores the defaults", () => {
    const changed = setBinding(structuredClone(DEFAULT_BINDINGS), "jump", 0, "KeyJ");
    assert.notDeepEqual(changed, DEFAULT_BINDINGS);
    assert.deepEqual(resetBindings(), DEFAULT_BINDINGS);
  });

  it("parsing tolerates garbage and keeps valid parts", () => {
    assert.deepEqual(parseBindings(null), DEFAULT_BINDINGS);
    assert.deepEqual(parseBindings("nope"), DEFAULT_BINDINGS);
    assert.deepEqual(parseBindings({}), DEFAULT_BINDINGS);
    const partial = parseBindings({ jump: ["KeyJ"], dodge: "Q", unknown: ["X"] });
    assert.deepEqual(partial.jump, ["KeyJ"]);
    assert.deepEqual(partial.dodge, DEFAULT_BINDINGS.dodge, "non-array ignored");
    assert.deepEqual(partial.forward, DEFAULT_BINDINGS.forward);
  });

  it("round-trips through storage", async () => {
    const { loadBindings, saveBindings } = await import("../src/input/bindings.js");
    const store = memStore();
    const changed = setBinding(structuredClone(DEFAULT_BINDINGS), "flight", 0, "KeyV");
    saveBindings(changed, store);
    assert.deepEqual(loadBindings(store), changed);
  });

  it("pretty-prints common codes", () => {
    assert.equal(prettyCode("KeyW"), "W");
    assert.equal(prettyCode("ArrowUp"), "↑");
    assert.equal(prettyCode("Space"), "Space");
  });

  it("InputState honors rebound bindings end to end", async () => {
    const { InputState } = await import("../src/input/input.js");
    const { IntentButton } = await import("@mmo-engine/protocol");
    const rebound = setBinding(structuredClone(DEFAULT_BINDINGS), "dodge", 0, "KeyX");
    const input = new InputState(rebound);
    input.keyDown("KeyX");
    assert.notEqual(input.toIntent().buttons & IntentButton.Dodge, 0, "X dodges after rebind");
    const plain = new InputState(rebound);
    plain.keyDown("KeyQ");
    assert.equal(plain.toIntent().buttons & IntentButton.Dodge, 0, "Q stolen, dodges no more");
  });

  it("setBindings swaps live and drops keys no longer bound", async () => {
    const { InputState } = await import("../src/input/input.js");
    const input = new InputState();
    input.keyDown("KeyQ");
    assert.equal(input.consumeDirty(), true);
    input.setBindings(setBinding(structuredClone(DEFAULT_BINDINGS), "dodge", 0, "KeyX"));
    assert.equal(input.consumeDirty(), true, "dropping a held key marks dirty");
    input.keyDown("KeyQ");
    assert.equal(input.consumeDirty(), false, "Q ignored after unbind");
  });
});
