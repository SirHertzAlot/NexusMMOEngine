/**
 * Viewport-panel fixes: the shared drag threshold (flow/graph jitter), the
 * scene-name rule (scenes panel), and the failure-then-retry path the Flow
 * and Story Retry buttons re-drive (host down, then back).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DRAG_THRESHOLD_PX, pastDragThreshold } from "../src/ui/drag-threshold.js";
import { SCENE_NAME_RE, isValidSceneName } from "../src/ui/scenes-panel.js";
import { getFlow } from "../src/flow-client.js";
import { loadStory } from "../src/story-client.js";

type Seen = Array<{ url: string; init?: RequestInit }>;

function fakeFetch(handler: (url: string) => { status: number; body: unknown }, seen: Seen): void {
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    const r = handler(url);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
}

describe("drag threshold", () => {
  it("is 5px, like the dungeon click rule", () => {
    assert.equal(DRAG_THRESHOLD_PX, 5);
  });
  it("ignores sub-threshold jitter and passes at 5px", () => {
    assert.equal(pastDragThreshold(0, 0, 0, 0), false);
    assert.equal(pastDragThreshold(10, 10, 11, 11), false);
    assert.equal(pastDragThreshold(0, 0, 3, 4), true, "exactly 5px counts");
    assert.equal(pastDragThreshold(0, 0, 4, 4), true);
    assert.equal(pastDragThreshold(0, 0, -3, -4), true, "direction does not matter");
  });
  it("accepts a custom threshold", () => {
    assert.equal(pastDragThreshold(0, 0, 3, 4, 6), false);
    assert.equal(pastDragThreshold(0, 0, 3, 4, 5), true);
  });
});

describe("scene name validation", () => {
  it("enforces ^[a-z0-9][a-z0-9-]*$", () => {
    assert.equal(String(SCENE_NAME_RE), String(/^[a-z0-9][a-z0-9-]*$/));
    for (const ok of ["arena", "a", "9", "crypt-2", "a-b-c-1", "x-"]) assert.equal(isValidSceneName(ok), true, ok);
    for (const bad of ["", "Arena", "ARENA", "-abc", "-", "a_b", "a b", "a/b", "a!", "a.b"]) assert.equal(isValidSceneName(bad), false, JSON.stringify(bad));
  });
});

describe("panel retry path", () => {
  it("getFlow rejects while the host is down and resolves on retry", async () => {
    const seen: Seen = [];
    let calls = 0;
    const doc = { version: 1, start: "a", nodes: { a: { scene: "login" } }, edges: [] };
    fakeFetch(() => {
      calls++;
      if (calls === 1) return { status: 500, body: { ok: false, error: "host is down" } };
      return { status: 200, body: { content: doc, scenes: ["login"], events: [] } };
    }, seen);
    await assert.rejects(getFlow(), /host is down/);
    const retry = await getFlow();
    assert.equal(retry.content.start, "a");
    assert.equal(calls, 2, "the retry re-calls getFlow once");
  });
  it("loadStory rejects while the host is down and loads all four documents on retry", async () => {
    const seen: Seen = [];
    let calls = 0;
    fakeFetch(() => {
      calls++;
      if (calls === 1) return { status: 500, body: { ok: false, error: "host is down" } };
      return { status: 200, body: { content: {}, refs: { items: [], species: [] } } };
    }, seen);
    await assert.rejects(loadStory(), /host is down/);
    const retry = await loadStory();
    assert.deepEqual(Object.keys(retry.files).sort(), ["dialogs", "npcs", "quests", "steps"]);
    assert.equal(calls, 5, "one failed attempt plus four retried documents");
  });
});
