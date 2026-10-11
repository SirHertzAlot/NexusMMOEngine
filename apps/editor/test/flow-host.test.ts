/** Flow host: the single content/flow/game.flow.json, validated saves, refused saves write nothing. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFlowNode, type FlowDoc } from "@mmo-engine/scene";
import { handleFlowRoute } from "../src/flow-host.js";

const DOC: FlowDoc = {
  version: 1,
  start: "login",
  nodes: { login: { scene: "login" }, world: { scene: "@assigned" } },
  edges: [{ from: "login", on: "net.joinReply.ok", to: "world" }],
};
function fakeRepo(): string {
  const root = join(tmpdir(), `mmo-flow-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  mkdirSync(join(root, "content", "flow"), { recursive: true });
  mkdirSync(join(root, "content", "scenes"), { recursive: true });
  writeFileSync(join(root, "content", "flow", "game.flow.json"), JSON.stringify(DOC));
  return root;
}
const put = (root: string, content: unknown) => handleFlowRoute(root, "PUT", "/api/editor/flow", JSON.stringify({ content }));

describe("flow routes", () => {
  it("ignores other paths", () => {
    assert.equal(handleFlowRoute("x", "GET", "/api/editor/scenes", undefined), null);
  });
  it("GET returns the document and the scene names a node may use", () => {
    const root = fakeRepo();
    writeFileSync(join(root, "content", "scenes", "hub.scene.json"), "{}");
    const r = handleFlowRoute(root, "GET", "/api/editor/flow", undefined);
    const b = r?.body as { content: FlowDoc; scenes: string[]; events: string[] };
    assert.equal(r?.status, 200);
    assert.deepEqual(b.content, DOC);
    assert.ok(b.scenes.includes("hub") && b.scenes.includes("login") && b.scenes.includes("@assigned"));
    assert.ok(b.events.includes("ui.submit"));
    rmSync(root, { recursive: true });
  });
  it("saves a valid edit", () => {
    const root = fakeRepo();
    const next = { ...DOC, edges: [...DOC.edges, { from: "world", on: "net.closed", to: "login" }] };
    assert.equal(put(root, next)?.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "content", "flow", "game.flow.json"), "utf8")), next);
    assert.deepEqual(readdirSync(join(root, "content", "flow")), ["game.flow.json"]);
    rmSync(root, { recursive: true });
  });
  it("a refused save (unreachable node, unknown scene) answers 400 with issues and writes nothing", () => {
    const root = fakeRepo();
    const before = readFileSync(join(root, "content", "flow", "game.flow.json"), "utf8");
    const r = put(root, addFlowNode(DOC, "island", { scene: "login" }));
    assert.equal(r?.status, 400);
    assert.ok((r?.body as { issues: { path: string }[] }).issues.some((i) => i.path === "nodes.island"));
    assert.equal(put(root, addFlowNode(DOC, "x", { scene: "nonesuch" }))?.status, 400);
    assert.equal(handleFlowRoute(root, "PUT", "/api/editor/flow", "not json")?.status, 400);
    assert.equal(readFileSync(join(root, "content", "flow", "game.flow.json"), "utf8"), before);
    assert.deepEqual(readdirSync(join(root, "content", "flow")), ["game.flow.json"]);
    rmSync(root, { recursive: true });
  });
  it("only the one fixed document exists", () => {
    const root = fakeRepo();
    assert.equal(handleFlowRoute(root, "GET", "/api/editor/flow/other", undefined)?.status, 404);
    rmSync(root, { recursive: true });
  });
});
