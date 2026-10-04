/** E6: the edge's metric catalog, GET /metrics with and without the core, and log hygiene. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { ChannelClient, serveChannel, type ChannelPacket } from "@mmo-engine/channel";
import { LIFECYCLE_EVENTS, netLogger, Registry } from "@mmo-engine/nethealth";
import { createCoreMetricsProxy, createEdgeMetrics, EDGE_METRIC_NAMES, metricsHandler, packetTypeLabel, recordRoute } from "../src/metrics.js";

/** The catalog in docs/EDGE-CORE-SPLIT.md (slice E6), word for word. */
const SPEC_EDGE = [
  "mmo_edge_ws_connections", "mmo_edge_ws_connects_total", "mmo_edge_ws_disconnects_total",
  "mmo_edge_router_requests_total", "mmo_edge_router_errors_total", "mmo_edge_router_latency_ms",
  "mmo_edge_mirror_deltas_fanned_out_total", "mmo_edge_mirror_snapshot_age_ticks",
  "mmo_edge_core_metrics_stale",
];
const SPEC_CHANNEL = [
  "mmo_channel_requests_total", "mmo_channel_timeouts_total", "mmo_channel_errors_total",
  "mmo_channel_request_latency_ms", "mmo_channel_pushes_total",
  "mmo_channel_bytes_sent_total", "mmo_channel_bytes_received_total",
  "mmo_channel_reconnects_total", "mmo_channel_heartbeat_missed_total",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("catalog: the edge registers exactly the spec's edge and channel metrics", () => {
  const m = createEdgeMetrics();
  assert.deepEqual([...m.registry.names()].sort(), [...SPEC_EDGE, ...SPEC_CHANNEL].sort());
  assert.deepEqual([...EDGE_METRIC_NAMES].sort(), [...SPEC_EDGE].sort());
});

test("router metrics: requests, latency and each error kind, with bounded packet_type labels", () => {
  const m = createEdgeMetrics();
  const routed = new Set(["ping", "player.intent"]);
  recordRoute(m, packetTypeLabel("ping", routed), "ping", 0.3);
  recordRoute(m, packetTypeLabel("player.intent", routed), "core.unavailable", 2);
  recordRoute(m, packetTypeLabel("made.up.1", routed), "error.unknown_packet", 0.1);
  recordRoute(m, packetTypeLabel("made.up.2", routed), "error.unknown_packet", 0.1);
  recordRoute(m, packetTypeLabel(42, routed), "error.bad_packet", 0.1);
  assert.equal(m.routerRequests.get({ packet_type: "ping" }), 1);
  assert.equal(m.routerRequests.get({ packet_type: "unknown" }), 2);
  assert.equal(m.routerErrors.get({ packet_type: "player.intent", error: "core_unavailable" }), 1);
  assert.equal(m.routerErrors.get({ packet_type: "unknown", error: "unknown_packet" }), 2);
  assert.equal(m.routerErrors.get({ packet_type: "none", error: "bad_packet" }), 1);
  assert.equal(m.routerErrors.series.size, 3);
  assert.match(m.registry.scrape(), /^mmo_edge_router_latency_ms_count\{packet_type="ping"\} 1$/m);
});

async function serve(app: express.Express): Promise<{ url: string; close(): void }> {
  const s = app.listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/metrics`, close: () => s.close() };
}

test("GET /metrics: edge + core in one exposition; edge-only with stale=1 when the core is down", async (t) => {
  const coreReg = new Registry("mmo_");
  coreReg.counter("core_intents_accepted_total", "Intents.").inc(undefined, 4);
  coreReg.counter("channel_requests_total", "Requests.", ["side"]).inc({ side: "core" }, 9);
  const core = await serveChannel(0, async (p: ChannelPacket) => {
    if (p.type === "metrics.get") return coreReg.scrape();
    throw new Error("unknown packet type " + p.type);
  });
  const m = createEdgeMetrics();
  const channel = new ChannelClient({ port: core.port, metrics: m.channel });
  t.after(() => channel.close());
  t.after(() => core.close());
  await channel.connect();
  const proxy = createCoreMetricsProxy(channel, m, 50, 200);
  const app = express();
  app.get("/metrics", metricsHandler(m, proxy));
  const http = await serve(app);
  t.after(() => http.close());

  await proxy.refresh();
  let res = await fetch(http.url);
  assert.equal(res.headers.get("content-type"), "text/plain; version=0.0.4");
  let body = await res.text();
  assert.match(body, /^mmo_edge_core_metrics_stale 0$/m);
  assert.match(body, /^mmo_core_intents_accepted_total 4$/m);
  // The shared family is declared once and carries both sides.
  assert.equal(body.match(/^# TYPE mmo_channel_requests_total /gm)!.length, 1);
  assert.match(body, /^mmo_channel_requests_total\{side="core"\} 9$/m);
  assert.match(body, /^mmo_channel_requests_total\{side="edge"\} 1$/m);

  await core.close();
  await sleep(50);
  await proxy.refresh();
  body = await (await fetch(http.url)).text();
  assert.match(body, /^mmo_edge_core_metrics_stale 1$/m);
  assert.doesNotMatch(body, /mmo_core_/);
  assert.match(body, /^mmo_edge_ws_connections 0$/m);
});

test("logs: every lifecycle event is one JSON line with the required fields and no secrets", () => {
  const lines: string[] = [];
  for (const component of ["edge", "channel", "core"] as const) {
    const log = netLogger(component, (l) => lines.push(l));
    for (const event of LIFECYCLE_EVENTS) {
      log.log("info", event, { code: 1000, attempt: 2, bytes: 9, token: "tok-secret", payload: "player-data", password: "hunter2", username: "alice" });
    }
  }
  assert.equal(lines.length, 3 * LIFECYCLE_EVENTS.length);
  for (const line of lines) {
    assert.ok(!line.includes("\n"));
    const o = JSON.parse(line) as Record<string, unknown>;
    for (const k of ["ts", "level", "component", "event"]) assert.ok(k in o, k);
    assert.ok(!Number.isNaN(Date.parse(o.ts as string)));
    for (const k of ["token", "payload", "password", "username"]) assert.ok(!(k in o), k);
    assert.ok(!/tok-secret|player-data|hunter2|alice/.test(line));
  }
});
