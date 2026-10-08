import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addFlowEdge,
  addFlowNode,
  flowEventsTo,
  flowReachable,
  flowStep,
  removeFlowEdge,
  removeFlowNode,
  rewireFlowEdge,
  validateFlow,
  type FlowDoc,
} from "../src/index.js";

const game = (): FlowDoc =>
  JSON.parse(readFileSync(new URL("../../../../content/flow/game.flow.json", import.meta.url), "utf8")) as FlowDoc;

describe("game.flow.json", () => {
  it("is valid with every node reachable", () => {
    assert.deepEqual(validateFlow(game()), []);
    assert.equal(flowReachable(game()).size, Object.keys(game().nodes).length);
  });
  it("walks login -> select -> creation -> world as before", () => {
    const d = game();
    let n = d.start;
    for (const [ev, want] of [
      ["ui.submit", "connecting"],
      ["net.account", "character-select"],
      ["ui.create", "character-creation"],
      ["net.joinReply.ok", "world"],
      ["net.closed", "login"],
    ] as const) {
      n = flowStep(d, n, ev);
      assert.equal(n, want);
    }
  });
  it("ignores events with no edge", () => {
    assert.equal(flowStep(game(), "login", "net.closed"), "login");
  });
  it("finds the event path to a node", () => {
    assert.deepEqual(flowEventsTo(game(), "character-creation"), ["ui.submit", "net.account", "ui.create"]);
    assert.deepEqual(flowEventsTo(game(), "login"), []);
    assert.equal(flowEventsTo(game(), "nope"), null);
  });
});

describe("validateFlow", () => {
  it("flags an unreachable node", () => {
    const d = addFlowNode(game(), "island", { scene: "login" });
    const issues = validateFlow(d);
    assert.ok(issues.some((i) => i.path === "nodes.island" && /unreachable/.test(i.message)));
  });
  it("flags missing start, dangling edges, unknown events and scenes", () => {
    const d = game();
    const bad = {
      ...d,
      start: "ghost",
      edges: [...d.edges, { from: "login", on: "ui.bogus", to: "nowhere" }],
      nodes: { ...d.nodes, x: { scene: "nonesuch" } },
    };
    const msgs = validateFlow(bad, { scenes: [] }).map((i) => i.path + ":" + i.message);
    assert.ok(msgs.some((m) => m.startsWith("start:")));
    assert.ok(msgs.some((m) => /edges\.\d+\.to:/.test(m)));
    assert.ok(msgs.some((m) => /edges\.\d+\.on:/.test(m)));
    assert.ok(msgs.some((m) => m.startsWith("nodes.x.scene:")));
  });
  it("rejects non-objects and bad versions", () => {
    assert.ok(validateFlow(null).length > 0);
    assert.ok(validateFlow({ ...game(), version: 9 }).length > 0);
  });
});

describe("edit ops", () => {
  it("are pure and consistent", () => {
    const d = game();
    const before = JSON.stringify(d);
    const e = addFlowEdge(d, { from: "login", on: "net.error", to: "connecting" });
    assert.equal(JSON.stringify(d), before);
    assert.equal(e.edges.length, d.edges.length + 1);
    const idx = e.edges.length - 1;
    assert.equal(rewireFlowEdge(e, idx, "login").edges[idx].to, "login");
    assert.equal(removeFlowEdge(e, idx).edges.length, d.edges.length);
    const r = removeFlowNode(d, "world");
    assert.ok(!("world" in r.nodes));
    assert.ok(r.edges.every((x) => x.from !== "world" && x.to !== "world"));
  });
});
