/**
 * Play uses the open scene (EA6): the server-control adapter posts the
 * provider's scene with the start request, and nothing when there is none.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { emptyScene } from "@mmo-engine/scene";
import { createHostServerControl } from "../src/server-control.js";
import { openScene, playableScene } from "../src/open-scene.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  openScene.set(null);
});

function stubFetch(): { bodies: string[] } {
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ ok: true, pid: 1, port: 7777, url: "ws://x", username: "u", password: "p" }), { status: 200 });
  }) as typeof fetch;
  return { bodies };
}

describe("createHostServerControl with a scene provider", () => {
  it("sends the open scene's name and document", async () => {
    const f = stubFetch();
    const doc = emptyScene("arena", "arena");
    openScene.set({ name: "arena", doc });
    await createHostServerControl("", playableScene).start();
    assert.deepEqual(JSON.parse(f.bodies[0]), { scene: { name: "arena", content: doc } });
  });
  it("does not send a frontend scene (client-only)", async () => {
    const f = stubFetch();
    openScene.set({ name: "login", doc: emptyScene("login", "frontend") });
    await createHostServerControl("", playableScene).start();
    assert.deepEqual(JSON.parse(f.bodies[0]), {});
  });
  it("sends no scene when none is open", async () => {
    const f = stubFetch();
    await createHostServerControl("", playableScene).start();
    assert.deepEqual(JSON.parse(f.bodies[0]), {});
  });
  it("without a provider behaves as before", async () => {
    const f = stubFetch();
    await createHostServerControl().start();
    assert.deepEqual(JSON.parse(f.bodies[0]), {});
  });
});
