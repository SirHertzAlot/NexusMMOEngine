import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../src/registry.js";
import { mergeExpositions } from "../src/prometheus.js";

test("exact text format: HELP, TYPE, samples, labels, escaping", () => {
  const r = new Registry("mmo_");
  r.gauge("ws_connections", "Active WebSocket connections.").set(2);
  const c = r.counter("router_requests_total", "Packets routed.", ["packet_type"]);
  c.inc({ packet_type: "ping" }, 3);
  c.inc({ packet_type: 'odd"type\\' });
  r.histogram("router_latency_ms", "routePacket duration.\nms.", [], [1]).observe(0.25);
  assert.equal(r.scrape(), [
    "# HELP mmo_ws_connections Active WebSocket connections.",
    "# TYPE mmo_ws_connections gauge",
    "mmo_ws_connections 2",
    "# HELP mmo_router_requests_total Packets routed.",
    "# TYPE mmo_router_requests_total counter",
    'mmo_router_requests_total{packet_type="ping"} 3',
    'mmo_router_requests_total{packet_type="odd\\"type\\\\"} 1',
    "# HELP mmo_router_latency_ms routePacket duration.\\nms.",
    "# TYPE mmo_router_latency_ms histogram",
    'mmo_router_latency_ms_bucket{le="1"} 1',
    'mmo_router_latency_ms_bucket{le="+Inf"} 1',
    "mmo_router_latency_ms_sum 0.25",
    "mmo_router_latency_ms_count 1",
    "",
  ].join("\n"));
});

test("a labelled metric with no samples yet prints only its HELP and TYPE", () => {
  const r = new Registry();
  r.counter("x_total", "X.", ["k"]);
  assert.equal(r.scrape(), "# HELP x_total X.\n# TYPE x_total counter\n");
});

test("merging two scrapes declares a shared family once and keeps every sample", () => {
  const edge = new Registry("mmo_");
  edge.counter("channel_requests_total", "Requests.", ["side"]).inc({ side: "edge" }, 3);
  edge.gauge("edge_ws_connections", "Connections.").set(2);
  const core = new Registry("mmo_");
  core.counter("channel_requests_total", "Requests.", ["side"]).inc({ side: "core" }, 5);
  core.counter("core_intents_accepted_total", "Intents.").inc();
  assert.equal(mergeExpositions(edge.scrape(), core.scrape()), [
    "# HELP mmo_channel_requests_total Requests.",
    "# TYPE mmo_channel_requests_total counter",
    'mmo_channel_requests_total{side="edge"} 3',
    'mmo_channel_requests_total{side="core"} 5',
    "# HELP mmo_edge_ws_connections Connections.",
    "# TYPE mmo_edge_ws_connections gauge",
    "mmo_edge_ws_connections 2",
    "# HELP mmo_core_intents_accepted_total Intents.",
    "# TYPE mmo_core_intents_accepted_total counter",
    "mmo_core_intents_accepted_total 1",
  ].join("\n") + "\n");
});
