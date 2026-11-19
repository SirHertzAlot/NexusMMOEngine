import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HelloAuth } from "@mmo-engine/mirror";
import type { AdminResult } from "@mmo-engine/protocol";
import { BackendClient, type ClientLike } from "../src/backend.js";
import {
  buildEntityFootprint,
  checkGraphStaleness,
  indexEcsGraph,
  parseLiveEntityOverlay,
  type EcsGraphPayload,
  type LiveEntityOverlay,
} from "../src/ecs-graph-model.js";
import { handleGraphRoute } from "../src/graph-host.js";
import { EcsFootprintContent } from "../src/ui/ecs-footprint.js";

const SAMPLE_GRAPH: EcsGraphPayload = {
  meta: {
    schemaVersion: 1,
    builtFromCommit: "abc1234567890fedcba",
    graphHash: "deadbeef0001",
    counts: { components: 2, systems: 2, declaredSystems: 1, simulationSystems: 2 },
  },
  nodes: [
    {
      id: "component:Transform",
      kind: "component",
      name: "Transform",
      fields: [
        { name: "px", type: "f32" },
        { name: "py", type: "f32" },
      ],
    },
    { id: "component:Health", kind: "component", name: "Health", fields: [{ name: "current", type: "f32" }] },
    { id: "field:Transform.px", kind: "field", name: "px", component: "Transform" },
    { id: "system:integrate", kind: "system", name: "integrate", role: "simulation", tickIndex: 1, declared: true },
    { id: "system:combat", kind: "system", name: "combat", role: "simulation", tickIndex: 4, declared: false },
    { id: "widget:viewport", kind: "widget", name: "Viewport" },
    { id: "archetype:guard_npc", kind: "archetype", name: "guard_npc" },
    { id: "object:obj_guard_01", kind: "object", name: "Town Guard", archetype: "archetype:guard_npc" },
    { id: "object:obj_crate_99", kind: "object", name: "Crate", archetype: "archetype:crate" },
  ],
  edges: [
    { from: "system:integrate", to: "field:Transform.px", kind: "writes", confidence: "declared", source: "s" },
    { from: "system:combat", to: "component:Health", kind: "writes", confidence: "inferred", source: "s" },
    { from: "system:combat", to: "component:Transform", kind: "reads", confidence: "declared", source: "s" },
    { from: "system:integrate", to: "component:Health", kind: "excludes", confidence: "declared", source: "s" },
    { from: "component:Transform", to: "widget:viewport", kind: "summons", confidence: "extracted", source: "s" },
    { from: "archetype:guard_npc", to: "component:Transform", kind: "hasComponent", confidence: "extracted", source: "s" },
    { from: "object:obj_guard_01", to: "archetype:guard_npc", kind: "instantiates", confidence: "extracted", source: "s" },
    { from: "object:obj_crate_99", to: "archetype:crate", kind: "instantiates", confidence: "extracted", source: "s" },
  ],
};

class FakeLiveClient implements ClientLike {
  sessionToken: string | null = "tok";
  lastCommand = "";
  lastArgs: unknown = undefined;
  nextMessage = "";
  ok = true;
  async connect(): Promise<unknown> {
    return {};
  }
  disconnect(): void {}
  async admin(command: string, args?: unknown): Promise<AdminResult> {
    this.lastCommand = command;
    this.lastArgs = args;
    return { kind: "admin", command, ok: this.ok, message: this.nextMessage };
  }
  async debug(): Promise<never> {
    throw new Error("no debug");
  }
}

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Graphify H4 editor model & host route", () => {
  it("compares builtFromCommit against server buildCommit and offline HEAD for staleness", () => {
    const synced = checkGraphStaleness("abc1234567890", "abc1234567890", "other9999999");
    assert.equal(synced.state, "synced");
    assert.match(synced.reason, /synced · abc12345/);

    const serverStale = checkGraphStaleness("abc1234567890", "ff0011223344", "abc1234567890");
    assert.equal(serverStale.state, "stale");
    assert.equal(serverStale.compareLabel, "server");
    assert.match(serverStale.reason, /stale · graph abc12345 != server ff001122/);

    const headStale = checkGraphStaleness("abc1234567890", null, "112233445566");
    assert.equal(headStale.state, "stale");
    assert.equal(headStale.compareLabel, "repo HEAD");

    const unknown = checkGraphStaleness("", null, null);
    assert.equal(unknown.state, "unknown");
  });

  it("joins static ecs-graph relationships with live inspect overlay and renders EcsFootprintContent", () => {
    const index = indexEcsGraph({ ...SAMPLE_GRAPH, currentHead: "abc1234567890fedcba" });
    const overlay: LiveEntityOverlay = {
      wireId: "42",
      slot: 1,
      tick: 88,
      buildCommit: "abc1234567890fedcba",
      components: [
        {
          component: "Transform",
          fields: [
            { name: "px", value: 12.5, lastWriter: { system: "integrate", tick: 87 } },
            { name: "py", value: 0 },
          ],
        },
        {
          component: "Health",
          fields: [{ name: "current", value: 90, lastWriter: { system: "combat", tick: 85 } }],
        },
      ],
    };

    const footprint = buildEntityFootprint(index, {
      componentNames: ["transform", "health"],
      objectId: "obj_guard_01",
      live: overlay,
    });

    assert.equal(footprint.archetypeId, "archetype:guard_npc");
    const tr = footprint.components.find((c) => c.component === "Transform")!;
    assert.deepEqual(tr.widgets, ["viewport"]);
    assert.equal(tr.writers[0].system, "integrate");
    assert.equal(tr.writers[0].confidence, "declared");
    assert.equal(tr.readers[0].system, "combat");
    assert.deepEqual(tr.fields.find((f) => f.name === "px")?.lastWriter, { system: "integrate", tick: 87 });

    const hp = footprint.components.find((c) => c.component === "Health")!;
    assert.equal(hp.writers[0].confidence, "inferred");
    assert.equal(hp.excludes[0].system, "integrate");

    const staleness = checkGraphStaleness(index.meta.builtFromCommit, overlay.buildCommit, index.currentHead);
    const html = renderToStaticMarkup(
      React.createElement(EcsFootprintContent, { footprint, staleness, overlay }),
    );
    assert.ok(html.includes('data-testid="ecs-footprint-panel"'));
    assert.ok(html.includes("synced · abc12345"));
    assert.ok(html.includes("guard_npc"));
    assert.ok(html.includes("integrate @ t87"));
    assert.ok(html.includes("inferred"));
    assert.ok(html.includes("viewport"));
  });

  it("BackendClient.inspectLive requests inspect { format: 'json' } and refuses errors", async () => {
    const fake = new FakeLiveClient();
    const client = new BackendClient(
      "ws://fake",
      { username: "u", password: "password12" } as HelloAuth,
      { onTick: () => {}, onClose: () => {}, onReconnect: () => {}, onError: () => {} },
      {},
      () => fake,
    );
    (client as unknown as { client: ClientLike; state: string }).client = fake;
    (client as unknown as { state: string }).state = "live";

    const payload: LiveEntityOverlay = {
      wireId: "7",
      slot: 0,
      tick: 12,
      buildCommit: "cafebabe1234",
      components: [{ component: "Health", fields: [{ name: "current", value: 75 }] }],
    };
    fake.nextMessage = JSON.stringify(payload);
    const res = await client.inspectLive("7");
    assert.equal(fake.lastCommand, "inspect");
    assert.deepEqual(fake.lastArgs, { entity: "7", format: "json" });
    assert.equal(res.wireId, "7");
    assert.equal(res.buildCommit, "cafebabe1234");
    assert.equal(parseLiveEntityOverlay(fake.nextMessage).components[0].fields[0].value, 75);

    fake.ok = false;
    fake.nextMessage = "denied";
    await assert.rejects(client.inspectLive("7"), /refused: denied/);
  });

  it("handleGraphRoute serves trimmed slice by default, attaches ?object=, and handles ?full=1", () => {
    const dir = mkdtempSync(join(tmpdir(), "mmo-graph-host-"));
    tempRoots.push(dir);
    assert.equal(handleGraphRoute(dir, "GET", "/api/editor/other"), null);
    assert.equal(handleGraphRoute(dir, "POST", "/api/editor/graph")?.status, 405);
    assert.equal(handleGraphRoute(dir, "GET", "/api/editor/graph")?.status, 404);

    mkdirSync(join(dir, ".git", "refs", "heads", "feat"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/feat/h4\n");
    writeFileSync(join(dir, ".git", "refs", "heads", "feat/h4"), "feedface1234567890\n");
    mkdirSync(join(dir, "content", "graph"), { recursive: true });
    writeFileSync(join(dir, "content", "graph", "ecs-graph.json"), JSON.stringify(SAMPLE_GRAPH));

    const def = handleGraphRoute(dir, "GET", "/api/editor/graph")!;
    assert.equal(def.status, 200);
    const defGraph = (def.body as { ok: true; graph: EcsGraphPayload }).graph;
    assert.equal(defGraph.currentHead, "feedface1234567890");
    assert.equal(defGraph.nodes.some((n) => n.kind === "object"), false, "default omits bulk scene objects");

    const targeted = handleGraphRoute(dir, "GET", "/api/editor/graph?object=obj_guard_01")!;
    const targetGraph = (targeted.body as { ok: true; graph: EcsGraphPayload }).graph;
    assert.equal(targetGraph.nodes.filter((n) => n.kind === "object").length, 1);
    assert.ok(targetGraph.nodes.some((n) => n.id === "object:obj_guard_01"));
    assert.ok(targetGraph.edges.some((e) => e.from === "object:obj_guard_01" && e.kind === "instantiates"));

    const full = handleGraphRoute(dir, "GET", "/api/editor/graph?full=1")!;
    const fullGraph = (full.body as { ok: true; graph: EcsGraphPayload }).graph;
    assert.equal(fullGraph.nodes.filter((n) => n.kind === "object").length, 2);
  });
});
