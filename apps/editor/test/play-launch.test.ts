/** What a setup does after the server is up (EA14): the start options, who plays where, the client addresses. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FlowDoc } from "@mmo-engine/scene";
import { clientWindowUrl, planLaunch, startOptions } from "../src/ui/play-launch.js";
import { defaultPlaySetup } from "../src/ui/play-setup.js";

const DOC: FlowDoc = {
  version: 1,
  start: "login",
  nodes: { login: { scene: "login" }, "character-creation": { scene: "character-creation" }, world: { scene: "@assigned" } },
  edges: [
    { from: "login", on: "ui.submit", to: "character-creation" },
    { from: "character-creation", on: "net.joinReply.ok", to: "world" },
  ],
};
const eight = { ...defaultPlaySetup(), clients: "8", bots: "50", net: "Core only", latency: "200 ms", fresh: false, keep: true };

describe("play launch", () => {
  it("startOptions is what the host start route is told", () => {
    assert.deepEqual(startOptions(eight), { bots: 50, clients: 8, network: "core", latencyMs: 200, fresh: false, keep: true });
    assert.equal(startOptions(defaultPlaySetup()).network, "edge");
  });

  it("viewport plays account 1 in the view and opens the rest in the player's client", () => {
    const p = planLaunch(eight, DOC);
    assert.equal(p.viewportAccount, 0);
    assert.deepEqual(p.windowAccounts, [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(p.teleportToCamera, false);
  });

  it("camera start plays the world node and moves the avatar", () => {
    const p = planLaunch({ ...defaultPlaySetup(), from: "@camera" }, DOC);
    assert.equal(p.node, "world");
    assert.equal(p.viewportAccount, 0);
    assert.equal(p.teleportToCamera, true);
  });

  it("window and non-world starts leave the viewport empty; simulate joins nobody", () => {
    assert.deepEqual(planLaunch({ ...defaultPlaySetup(), where: "window", clients: "2" }, DOC), { node: "world", viewportAccount: null, windowAccounts: [0, 1], teleportToCamera: false });
    const login = planLaunch({ ...defaultPlaySetup(), from: "login" }, DOC);
    assert.equal(login.viewportAccount, null);
    assert.deepEqual(login.windowAccounts, [0]);
    assert.deepEqual(planLaunch({ ...defaultPlaySetup(), where: "simulate", clients: "4" }, DOC), { node: "world", viewportAccount: null, windowAccounts: [], teleportToCamera: false });
  });

  it("each window logs its own seeded account in at the node", () => {
    const server = { url: "ws://127.0.0.1:7777", user: "play-2", pass: "pw" };
    const r = clientWindowUrl(DOC, "world", "http://127.0.0.1:5173/", server);
    assert.ok("url" in r);
    const q = new URL((r as { url: string }).url).searchParams;
    assert.equal(q.get("start"), "world");
    assert.equal(q.get("server"), "ws://127.0.0.1:7777");
    assert.equal(q.get("user"), "play-2");
    assert.ok("error" in clientWindowUrl(DOC, "nowhere", "http://x", server));
  });
});
