import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MediaSaveError, getAudioEventNames, getMedia, getRigManifest, saveMedia } from "../src/media-client.js";

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; init?: RequestInit }>, type = "application/json"): void {
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return { ok: status < 400, status, json: async () => body, headers: { get: () => type } };
  };
}

describe("media-client", () => {
  it("gets a document by name", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    fakeFetch(200, { ok: true, content: { version: 1 } }, seen);
    assert.deepEqual(await getMedia("materials"), { version: 1 });
    assert.equal(seen[0].url, "/api/editor/media/materials");
  });
  it("a refused save throws MediaSaveError with the issues, and a good one PUTs the content", async () => {
    fakeFetch(400, { ok: false, error: "invalid", issues: [{ path: "fade", message: "bad" }] }, []);
    await assert.rejects(saveMedia("animation", {}), (e: unknown) => e instanceof MediaSaveError && e.issues[0].path === "fade");
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    fakeFetch(200, { ok: true }, seen);
    await saveMedia("combat", { moves: [] });
    assert.equal(seen[0].init?.method, "PUT");
    assert.deepEqual(JSON.parse(seen[0].init?.body as string), { content: { moves: [] } });
  });
  it("the rig manifest is null when the art is not here (404 or the dev server's index page)", async () => {
    fakeFetch(404, {}, []);
    assert.equal(await getRigManifest(), null);
    fakeFetch(200, {}, [], "text/html");
    assert.equal(await getRigManifest(), null);
    fakeFetch(200, { version: 2, sources: [], clips: [] }, []);
    assert.equal((await getRigManifest())?.version, 2);
  });
  it("lists the audio events by name, and none when the host is down", async () => {
    fakeFetch(200, { ok: true, content: { events: [{ name: "hit" }, { name: "footstep" }] } }, []);
    assert.deepEqual(await getAudioEventNames(), ["hit", "footstep"]);
    fakeFetch(500, {}, []);
    assert.deepEqual(await getAudioEventNames(), []);
  });
});
