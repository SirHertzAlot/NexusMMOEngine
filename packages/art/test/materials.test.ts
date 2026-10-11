/**
 * TDD: EA22 foundation — materials as data.
 *
 * `content/materials/*.json`: toon and surface material definitions.
 * The client loads them; tuning a material never touches code.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadMaterial } from "../src/materials.js";

describe("loadMaterial", () => {
  it("loads a toon material", () => {
    const m = loadMaterial({
      name: "hero-cloth",
      kind: "toon",
      color: "#8b5a2b",
      steps: 3,
    });
    assert.equal(m.name, "hero-cloth");
    assert.equal(m.kind, "toon");
  });

  it("loads a surface (PBR) material", () => {
    const m = loadMaterial({
      name: "iron",
      kind: "surface",
      color: "#888888",
      metalness: 0.9,
      roughness: 0.35,
    });
    assert.equal(m.kind, "surface");
    if (m.kind === "surface") {
      assert.equal(m.metalness, 0.9);
      assert.equal(m.roughness, 0.35);
    }
  });

  it("rejects a bad color", () => {
    assert.throws(() => loadMaterial({ name: "x", kind: "toon", color: "red" }), /color/);
  });

  it("rejects an unknown kind", () => {
    assert.throws(() => loadMaterial({ name: "x", kind: "glow", color: "#ffffff" }), /kind/);
  });

  it("fills defaults", () => {
    const m = loadMaterial({ name: "x", kind: "surface", color: "#ffffff" });
    if (m.kind === "surface") {
      assert.equal(m.metalness, 0);
      assert.equal(m.roughness, 1);
    } else {
      assert.fail("expected surface");
    }
  });

  it("toon materials accept an outline", () => {
    const m = loadMaterial({
      name: "x",
      kind: "toon",
      color: "#ffffff",
      outline: { color: "#000000", width: 0.02 },
    });
    if (m.kind === "toon") {
      assert.equal(m.outline?.width, 0.02);
    } else {
      assert.fail("expected toon");
    }
  });
});
