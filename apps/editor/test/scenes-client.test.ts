import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emptyScene } from "@mmo-engine/scene";
import { SceneSaveError, getScene, listScenes, saveScene } from "../src/scenes-client.js";

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; init?: RequestInit }>): void {
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return { ok: status < 400, status, json: async () => body };
  };
}

describe("scenes-client", () => {
  it("lists and gets", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    fakeFetch(200, { ok: true, scenes: ["arena"] }, seen);
    assert.deepEqual(await listScenes(), ["arena"]);
    fakeFetch(200, { ok: true, content: emptyScene("arena", "arena") }, seen);
    assert.equal((await getScene("arena")).name, "arena");
    assert.equal(seen[1].url, "/api/editor/scenes/arena");
  });
  it("a refused save throws SceneSaveError with the issues", async () => {
    const issues = [{ path: "kind", message: "bad" }];
    fakeFetch(400, { ok: false, error: "invalid scene", issues }, []);
    await assert.rejects(saveScene("arena", emptyScene("arena", "arena")), (e: unknown) => {
      return e instanceof SceneSaveError && e.issues[0].path === "kind";
    });
  });
});
