/** Network workspace: routes validation (the edge's rules), the metrics reader, and the host routes. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEdgeMetrics, validateRoutes } from "../src/network-model.js";
import { handleNetworkRoute, probeEdge, routesFile } from "../src/network-host.js";

const GOOD = { routes: [{ packetType: "ping", destination: "local:ping" }, { packetType: "player.intent", destination: "core" }] };

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "mmo-net-"));
  mkdirSync(join(root, "content", "edge"), { recursive: true });
  writeFileSync(routesFile(root), JSON.stringify(GOOD));
  return root;
}
const down = () => Promise.resolve({ running: false as const, port: 3000 });

describe("validateRoutes", () => {
  it("accepts what the edge loads", () => assert.deepEqual(validateRoutes(GOOD), []));
  it("names duplicate types, bad destinations, unknown keys and a missing array", () => {
    const issues = validateRoutes({ routes: [{ packetType: "a", destination: "core" }, { packetType: "a", destination: "edge" }, { packetType: "", destination: "local:x", extra: 1 }] });
    const text = issues.map((i) => `${i.path} ${i.message}`).join("\n");
    assert.match(text, /routes\[1\]\.packetType duplicate/);
    assert.match(text, /routes\[1\]\.destination/);
    assert.match(text, /routes\[2\]\.packetType/);
    assert.match(text, /routes\[2\]\.extra unknown/);
    assert.equal(validateRoutes({}).length, 1);
    assert.equal(validateRoutes([]).length, 1);
  });
});

describe("parseEdgeMetrics", () => {
  it("sums labelled samples of the shown metrics and skips the rest", () => {
    const text = [
      "# TYPE mmo_edge_ws_connections gauge",
      "mmo_edge_ws_connections 3",
      'mmo_edge_router_requests_total{type="ping"} 10',
      'mmo_edge_router_requests_total{type="player.intent"} 5',
      "mmo_other_thing 99",
    ].join("\n");
    assert.deepEqual(parseEdgeMetrics(text), { mmo_edge_ws_connections: 3, mmo_edge_router_requests_total: 15 });
  });
});

describe("probeEdge", () => {
  it("reads the scrape when the edge answers, and says not running when it does not", async () => {
    const up = (() => Promise.resolve({ ok: true, text: () => Promise.resolve("mmo_edge_ws_connections 2\n") })) as unknown as typeof fetch;
    assert.deepEqual(await probeEdge({ EDGE_HTTP_PORT: "3456" }, up), { running: true, port: 3456, metrics: { mmo_edge_ws_connections: 2 } });
    const refused = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    assert.deepEqual(await probeEdge({}, refused), { running: false, port: 3000 });
  });
});

describe("network routes", () => {
  it("ignores other paths", async () => assert.equal(await handleNetworkRoute("x", "GET", "/api/editor/flow", undefined), null));
  it("GET returns the routes, their issues and the edge probe", async () => {
    const r = await handleNetworkRoute(repo(), "GET", "/api/editor/network", undefined, down);
    const b = r?.body as { content: unknown; issues: unknown[]; edge: { running: boolean } };
    assert.deepEqual(b.content, GOOD);
    assert.deepEqual(b.issues, []);
    assert.equal(b.edge.running, false);
  });
  it("saves a valid edit", async () => {
    const root = repo();
    const next = { routes: [...GOOD.routes, { packetType: "chat.say", destination: "core" }] };
    assert.equal((await handleNetworkRoute(root, "PUT", "/api/editor/network", JSON.stringify({ content: next })))?.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(routesFile(root), "utf8")), next);
  });
  it("a refused save answers 400 with issues and leaves the file alone", async () => {
    const root = repo();
    const before = readFileSync(routesFile(root), "utf8");
    const r = await handleNetworkRoute(root, "PUT", "/api/editor/network", JSON.stringify({ content: { routes: [{ packetType: "x", destination: "nowhere" }] } }));
    assert.equal(r?.status, 400);
    assert.equal(readFileSync(routesFile(root), "utf8"), before);
  });
});
