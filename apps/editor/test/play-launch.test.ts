import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FlowDoc } from "@mmo-engine/scene";
import { clientWindows, startChoices, worldNodeOf } from "../src/ui/play-launch.js";
import { defaultPlaySetup } from "../src/ui/play-setup.js";

const doc = {
  version: 1,
  start: "login",
  nodes: {
    login: { scene: "login", x: 0, y: 0 },
    "character-select": { scene: "character-select", x: 0, y: 0 },
    world: { scene: "@assigned", x: 0, y: 0 },
  },
  edges: [
    { from: "login", on: "net.account", to: "character-select" },
    { from: "character-select", on: "net.joinReply.ok", to: "world" },
  ],
} as unknown as FlowDoc;

describe("play-launch", () => {
  it("finds the world node and lists the other nodes after World and the camera", () => {
    assert.equal(worldNodeOf(doc), "world");
    assert.equal(worldNodeOf(null), "world");
    assert.deepEqual(startChoices(doc, []).map((c) => c.value), ["World", "Camera position", "login", "character-select"]);
    assert.deepEqual(startChoices(null, ["World"]).map((c) => c.value), ["World"]);
  });

  it("opens one client address per account, each logging in as its own account", () => {
    const server = { url: "ws://127.0.0.1:7777", username: "editor-a", password: "pw", loadUsers: ["editor-a-load1", "editor-a-load2"] };
    const r = clientWindows({ ...defaultPlaySetup(), clients: "2" }, doc, "character-select", "http://127.0.0.1:5173/", server);
    assert.ok("windows" in r);
    assert.deepEqual(r.windows.map((w) => w.username), ["editor-a", "editor-a-load1"]);
    const q = new URL(r.windows[1]!.url).searchParams;
    assert.equal(q.get("start"), "character-select");
    assert.equal(q.get("user"), "editor-a-load1");
    assert.equal(q.get("server"), server.url);
  });

  it("refuses a node the flow cannot reach", () => {
    const cut = { ...(doc as object), edges: [] } as unknown as FlowDoc;
    const r = clientWindows(defaultPlaySetup(), cut, "character-select", "http://127.0.0.1:5173", { url: "ws://x", username: "u", password: "p" });
    assert.ok("error" in r);
  });
});
