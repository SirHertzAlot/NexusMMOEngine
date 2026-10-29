/**
 * Tests for Appearance & Equipment API, component integration, and mock data modification.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchAppearance, saveAppearance, fetchEquipment, saveEquipment } from "../src/api/appearance.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(responseBody: unknown) {
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify(responseBody), { status: 200 });
  }) as typeof fetch;
}

describe("Appearance and Equipment API & Mock Data", () => {
  it("fetches character appearance successfully", async () => {
    mockFetch({
      skinTone: "#123456",
      hairStyle: "Long",
      hairColor: "#654321",
      eyeColor: "#112233",
      height: 2.0,
      bodyBuild: "Muscular",
    });
    const app = await fetchAppearance("char_1");
    assert.equal(app.hairStyle, "Long");
    assert.equal(app.height, 2.0);
    assert.equal(app.bodyBuild, "Muscular");
  });

  it("modifies and saves mock appearance data", async () => {
    let savedBody: any = null;
    globalThis.fetch = (async (_url: any, init: any) => {
      savedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const modifiedAppearance = {
      skinTone: "#abcdef",
      hairStyle: "Spiky",
      hairColor: "#111111",
      eyeColor: "#222222",
      height: 1.9,
      bodyBuild: "Athletic",
    };

    const res = await saveAppearance(modifiedAppearance, "char_1");
    assert.equal(res.ok, true);
    assert.equal(savedBody.hairStyle, "Spiky");
    assert.equal(savedBody.height, 1.9);
    assert.equal(savedBody.skinTone, "#abcdef");
  });

  it("fetches and saves equipment data", async () => {
    mockFetch({
      slots: [
        { slot: "head", itemId: "helmet_02", itemName: "Gold Helm", rarity: "epic" },
      ],
    });
    const eq = await fetchEquipment("char_1");
    assert.equal(eq.slots.length, 1);
    assert.equal(eq.slots[0].itemName, "Gold Helm");
    assert.equal(eq.slots[0].rarity, "epic");

    let savedEq: any = null;
    globalThis.fetch = (async (_url: any, init: any) => {
      savedEq = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const newEq = {
      slots: [{ slot: "head", itemId: "crown_01", itemName: "King's Crown", rarity: "legendary" }],
    };
    const res = await saveEquipment(newEq, "char_1");
    assert.equal(res.ok, true);
    assert.equal(savedEq.slots[0].itemName, "King's Crown");
  });
});
