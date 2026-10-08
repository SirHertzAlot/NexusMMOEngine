import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { flowStep, validateFlow, type FlowDoc } from "@mmo-engine/scene";
import { screenOf, startNode } from "../src/flow.js";

const doc = JSON.parse(readFileSync(new URL("../../../../content/flow/game.flow.json", import.meta.url), "utf8")) as FlowDoc;

describe("client flow", () => {
  it("the shipped document is valid", () => {
    assert.deepEqual(validateFlow(doc), []);
  });
  it("maps nodes to the screens App mounts", () => {
    assert.equal(screenOf(doc, "login"), "login");
    assert.equal(screenOf(doc, "connecting"), "connecting");
    assert.equal(screenOf(doc, "character-select"), "characters");
    assert.equal(screenOf(doc, "character-creation"), "characters");
    assert.equal(screenOf(doc, "world"), "world");
    assert.equal(screenOf(doc, "gone"), "login");
  });
  it("drives the same screens the old Screen state did", () => {
    const seq = ["ui.submit", "net.account", "ui.create", "ui.select", "net.joinReply.ok", "net.closed"];
    const screens: string[] = [];
    let n = doc.start;
    for (const ev of seq) {
      n = flowStep(doc, n, ev);
      screens.push(screenOf(doc, n));
    }
    assert.deepEqual(screens, ["connecting", "characters", "characters", "characters", "world", "login"]);
    // a failed handshake goes back to login; a token rejoin goes straight to the world
    assert.equal(screenOf(doc, flowStep(doc, "connecting", "net.error")), "login");
    assert.equal(screenOf(doc, flowStep(doc, "connecting", "net.welcome")), "world");
  });
  it("?start= picks a node only when it exists", () => {
    assert.equal(startNode(doc, "?start=character-creation"), "character-creation");
    assert.equal(startNode(doc, "?start=nope"), "login");
    assert.equal(startNode(doc, ""), "login");
  });
});
