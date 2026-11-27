/**
 * The character screen's creation rules (roadmap EB7): fetched like the
 * client's other content, and never a reason for the screen not to draw.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CREATION_RULES } from "@mmo-engine/art/browser";
import { CREATION_RULES_URL, fetchCreationRules, slotLabel } from "../src/creation-rules.js";

const replying = (status: number, body: unknown): typeof fetch =>
  (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;

describe("the client's creation rules", () => {
  it("asks for the file the server validates against", async () => {
    let asked = "";
    const fetcher = (async (url: string) => {
      asked = url;
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    await fetchCreationRules(fetcher);
    assert.equal(asked, CREATION_RULES_URL);
  });

  it("uses the engine's defaults when a game has no file", async () => {
    assert.equal(await fetchCreationRules(replying(404, {})), DEFAULT_CREATION_RULES);
  });

  it("uses a game's file when it has one", async () => {
    const rules = await fetchCreationRules(replying(200, { parts: [{ slot: "head", optional: false }, { slot: "hair" }] }));
    assert.deepEqual(rules.parts.map((p) => p.slot), ["head", "hair"]);
    assert.deepEqual(rules.colours, DEFAULT_CREATION_RULES.colours, "what the file leaves out stays the engine's");
  });

  it("draws the defaults rather than nothing when the file is wrong or the server is down", async () => {
    const warn = console.warn;
    const said: unknown[] = [];
    console.warn = (...args: unknown[]) => said.push(args);
    try {
      assert.equal(await fetchCreationRules(replying(200, { parts: [] })), DEFAULT_CREATION_RULES);
      assert.equal(said.length, 1, "a file someone wrote and the engine refused is said out loud");
      const broken = (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch;
      assert.equal(await fetchCreationRules(broken), DEFAULT_CREATION_RULES);
    } finally {
      console.warn = warn;
    }
  });
});

describe("slot labels", () => {
  it("keeps the translation when there is one", () => {
    assert.equal(slotLabel("character.part.hair", "Hair"), "Hair");
  });

  it("reads a slot nobody wrote a string for", () => {
    assert.equal(slotLabel("character.part.helmet", "character.part.helmet"), "Helmet");
    assert.equal(slotLabel("character.part.headCovering", "character.part.headCovering"), "Head covering");
    assert.equal(slotLabel("character.colour.metalPrimary", "character.colour.metalPrimary"), "Metal primary");
  });
});
