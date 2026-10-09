/**
 * TDD: A6 appearance editor — the `appearance` admin command.
 *
 * Views and edits a character's look live: parts per slot and colours per
 * slot, validated against the modular catalog. Changes apply via
 * sim.setLook and sync to clients like any appearance update.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { parseAppearanceArgs, applyAppearanceEdit } from "../src/admin/appearance.js";
import { lookToJson, type CharacterLook, type ModularCatalog } from "@mmo-engine/art/character";

const BASE_LOOK: CharacterLook = {
  gender: "male",
  parts: { head: "head-male-01", torso: "torso-male-01" },
  colours: { skin: "#c9a186" },
};

function worldWithAvatar(): { sim: SimWorld; wireId: bigint } {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const eid = sim.spawn();
  sim.setLook(eid, lookToJson(BASE_LOOK));
  return { sim, wireId: sim.wireId(eid) };
}

describe("parseAppearanceArgs", () => {
  it("parses a part change", () => {
    const r = parseAppearanceArgs(["head", "head-male-02"]);
    assert.deepEqual(r, { ok: true, edit: { kind: "part", slot: "head", part: "head-male-02" } });
  });

  it("parses a colour change", () => {
    const r = parseAppearanceArgs(["colour", "skin", "#ff0000"]);
    assert.deepEqual(r, { ok: true, edit: { kind: "colour", slot: "skin", colour: "#ff0000" } });
  });

  it("parses 'clear' to remove a part", () => {
    const r = parseAppearanceArgs(["head", "clear"]);
    assert.deepEqual(r, { ok: true, edit: { kind: "part", slot: "head", part: null } });
  });

  it("rejects a bad colour", () => {
    const r = parseAppearanceArgs(["colour", "skin", "red"]);
    assert.equal(r.ok, false);
  });

  it("rejects empty args (shows the look instead)", () => {
    const r = parseAppearanceArgs([]);
    assert.deepEqual(r, { ok: true, edit: { kind: "show" } });
  });
});

describe("applyAppearanceEdit", () => {
  it("changes a part and the look JSON updates", () => {
    const { sim, wireId } = worldWithAvatar();
    const res = applyAppearanceEdit(sim, wireId, { kind: "part", slot: "head", part: "head-male-02" }, null);
    assert.equal(res.ok, true);
    const look = JSON.parse(sim.lookJson(C.Appearance.look[sim.resolveWireId(wireId)])) as CharacterLook;
    assert.equal(look.parts.head, "head-male-02");
  });

  it("changes a colour", () => {
    const { sim, wireId } = worldWithAvatar();
    const res = applyAppearanceEdit(sim, wireId, { kind: "colour", slot: "skin", colour: "#ff0000" }, null);
    assert.equal(res.ok, true);
    const look = JSON.parse(sim.lookJson(C.Appearance.look[sim.resolveWireId(wireId)])) as CharacterLook;
    assert.equal(look.colours.skin, "#ff0000");
  });

  it("refuses a part that is not in the catalog", () => {
    const { sim, wireId } = worldWithAvatar();
    const catalog: ModularCatalog = {
      version: 1,
      parts: [
        { name: "head-male-01", slot: "head", gender: "male", index: 1 },
        { name: "torso-male-01", slot: "torso", gender: "male", index: 1 },
      ],
    };
    const res = applyAppearanceEdit(sim, wireId, { kind: "part", slot: "head", part: "not-a-part" }, catalog);
    assert.equal(res.ok, false);
    assert.match(res.message ?? "", /not a part/i);
  });

  it("accepts a part that is in the catalog", () => {
    const { sim, wireId } = worldWithAvatar();
    const catalog: ModularCatalog = {
      version: 1,
      parts: [
        { name: "head-male-01", slot: "head", gender: "male", index: 1 },
        { name: "head-male-02", slot: "head", gender: "male", index: 2 },
        { name: "torso-male-01", slot: "torso", gender: "male", index: 1 },
      ],
    };
    const res = applyAppearanceEdit(sim, wireId, { kind: "part", slot: "head", part: "head-male-02" }, catalog);
    assert.equal(res.ok, true);
  });

  it("refuses an entity with no Appearance", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const eid = sim.spawn();
    const res = applyAppearanceEdit(sim, sim.wireId(eid), { kind: "part", slot: "head", part: "x" }, null);
    assert.equal(res.ok, false);
  });
});
