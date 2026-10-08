import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FlowSaveError, getFlow, playFromUrl, saveFlow } from "../src/flow-client.js";
import type { FlowDoc } from "@mmo-engine/scene";

const doc: FlowDoc = {
  version: 1,
  start: "login",
  nodes: {
    login: { scene: "login" },
    connecting: { scene: "loading" },
    "character-select": { scene: "character-select" },
    "character-creation": { scene: "character-creation" },
    world: { scene: "@assigned" },
  },
  edges: [
    { from: "login", on: "ui.submit", to: "connecting" },
    { from: "connecting", on: "net.account", to: "character-select" },
    { from: "character-select", on: "ui.create", to: "character-creation" },
    { from: "character-select", on: "net.joinReply.ok", to: "world" },
  ],
};

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; init?: RequestInit }>): void {
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return { ok: status < 400, status, json: async () => body };
  };
}

describe("flow-client", () => {
  it("gets the document with its scenes and events", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    fakeFetch(200, { ok: true, content: doc, scenes: ["login"], events: ["ui.submit"] }, seen);
    const r = await getFlow();
    assert.equal(r.content.start, "login");
    assert.equal(seen[0].url, "/api/editor/flow");
  });
  it("a refused save throws FlowSaveError with the issues", async () => {
    fakeFetch(400, { ok: false, error: "invalid flow", issues: [{ path: "nodes.x", message: "unreachable" }] }, []);
    await assert.rejects(saveFlow(doc), (e: unknown) => e instanceof FlowSaveError && e.issues[0].path === "nodes.x");
  });
});

describe("playFromUrl", () => {
  const client = "http://localhost:5173";
  it("login needs nothing", () => {
    assert.deepEqual(playFromUrl(doc, "login", { client }), { url: "http://localhost:5173/" });
  });
  it("character creation runs serverless through the preview route", () => {
    assert.deepEqual(playFromUrl(doc, "character-creation", { client }), { url: "http://localhost:5173/?preview=character" });
  });
  it("with a server, creation and world log in then jump to the node", () => {
    const server = { url: "ws://localhost:7777", user: "dev", pass: "secret-pass" };
    const w = playFromUrl(doc, "world", { client, server });
    assert.ok("url" in w);
    const q = new URL(w.url).searchParams;
    assert.equal(q.get("start"), "world");
    assert.equal(q.get("server"), "ws://localhost:7777");
    assert.equal(q.get("user"), "dev");
    const c = playFromUrl(doc, "character-creation", { client, server });
    assert.equal(new URL((c as { url: string }).url).searchParams.get("start"), "character-creation");
    assert.equal(new URL((c as { url: string }).url).searchParams.get("preview"), null);
  });
  it("world and select without a server explain what is missing", () => {
    assert.ok("error" in playFromUrl(doc, "world", { client }));
    assert.ok("error" in playFromUrl(doc, "character-select", { client }));
  });
  it("refuses unknown and unreachable nodes", () => {
    assert.ok("error" in playFromUrl(doc, "nope", { client }));
    const island = { ...doc, nodes: { ...doc.nodes, island: { scene: "login" } } };
    assert.ok("error" in playFromUrl(island, "island", { client }));
  });
});
