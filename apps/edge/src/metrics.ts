/**
 * Edge metrics and `GET /metrics` (slice E6 of docs/EDGE-CORE-SPLIT.md).
 *
 * One scrape covers the whole engine: the edge's own `mmo_edge_*`, the
 * channel's edge side (`mmo_channel_*{side="edge"}`), and the core's
 * metrics, which the edge fetches with `metrics.get` every 15 s and caches.
 * While that fetch fails the scrape carries edge metrics only, with
 * `mmo_edge_core_metrics_stale 1`.
 */
import type { RequestHandler } from "express";
import { channelMetrics, type ChannelLike, type ChannelMetrics } from "@mmo-engine/channel";
import { CONTENT_TYPE, mergeExpositions, Registry, type Counter, type Gauge, type Histogram } from "@mmo-engine/nethealth";

/** Every metric the edge process registers (the catalog test holds this to the spec). */
export const EDGE_METRIC_NAMES = [
  "mmo_edge_ws_connections",
  "mmo_edge_ws_connects_total",
  "mmo_edge_ws_disconnects_total",
  "mmo_edge_router_requests_total",
  "mmo_edge_router_errors_total",
  "mmo_edge_router_latency_ms",
  "mmo_edge_core_metrics_stale",
] as const;

/** `router_errors_total{error}` values: the four the router answers, and a local module throwing. */
export type RouterError = "unknown_packet" | "bad_packet" | "unknown_module" | "core_unavailable" | "internal";

const ERROR_OF: Record<string, RouterError> = {
  "error.unknown_packet": "unknown_packet",
  "error.bad_packet": "bad_packet",
  "error.unknown_module": "unknown_module",
  "core.unavailable": "core_unavailable",
  "error.internal": "internal",
};

export interface EdgeMetrics {
  readonly registry: Registry;
  readonly channel: ChannelMetrics;
  wsConnections: Gauge;
  wsConnects: Counter;
  wsDisconnects: Counter;
  routerRequests: Counter;
  routerErrors: Counter;
  routerLatency: Histogram;
  coreMetricsStale: Gauge;
}

export function createEdgeMetrics(): EdgeMetrics {
  const registry = new Registry("mmo_");
  return {
    registry,
    wsConnections: registry.gauge("edge_ws_connections", "Open client WebSocket connections."),
    wsConnects: registry.counter("edge_ws_connects_total", "Client WebSocket connections opened."),
    wsDisconnects: registry.counter("edge_ws_disconnects_total", "Client WebSocket connections closed."),
    routerRequests: registry.counter("edge_router_requests_total", "Packets routed, by packet type.", ["packet_type"]),
    routerErrors: registry.counter("edge_router_errors_total", "Routed packets answered with an error, by packet type and error.", ["packet_type", "error"]),
    routerLatency: registry.histogram("edge_router_latency_ms", "Time to route a packet and produce its answer, in ms.", ["packet_type"]),
    coreMetricsStale: registry.gauge("edge_core_metrics_stale", "1 while the core's metrics could not be fetched (the scrape then has edge metrics only)."),
    channel: channelMetrics(registry),
  };
}

/**
 * The `packet_type` label: a routed type as is; anything else collapses so
 * a client sending made-up types cannot grow the label set without bound.
 */
export function packetTypeLabel(type: unknown, routed: ReadonlySet<string>): string {
  if (typeof type !== "string") return "none";
  return routed.has(type) ? type : "unknown";
}

/** Count one routed packet and its answer. */
export function recordRoute(m: EdgeMetrics, packetType: string, responseType: string, ms: number): void {
  const labels = { packet_type: packetType };
  m.routerRequests.inc(labels);
  m.routerLatency.observe(ms, labels);
  const error = ERROR_OF[responseType];
  if (error) m.routerErrors.inc({ packet_type: packetType, error });
}

export interface CoreMetricsProxy {
  /** The core's last scrape text, or null while it is stale. */
  readonly text: string | null;
  /** Fetch now; never rejects. */
  refresh(): Promise<void>;
  /** Fetch now and every `intervalMs` until `stop()`. */
  start(): void;
  stop(): void;
}

export function createCoreMetricsProxy(channel: Pick<ChannelLike, "request">, m: EdgeMetrics, intervalMs = 15000, timeoutMs = 5000): CoreMetricsProxy {
  let text: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  m.coreMetricsStale.set(1);
  const proxy: CoreMetricsProxy = {
    get text() { return text; },
    async refresh() {
      try {
        const got = await channel.request("metrics.get", null, "metrics", timeoutMs);
        if (typeof got !== "string") throw new Error("metrics.get did not answer text");
        text = got;
        m.coreMetricsStale.set(0);
      } catch {
        text = null;
        m.coreMetricsStale.set(1);
      }
    },
    start() {
      if (timer) return;
      void proxy.refresh();
      timer = setInterval(() => void proxy.refresh(), intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
  return proxy;
}

/** The full scrape: edge registry plus the cached core text. */
export function scrapeAll(m: EdgeMetrics, core: Pick<CoreMetricsProxy, "text">): string {
  return core.text === null ? m.registry.scrape() : mergeExpositions(m.registry.scrape(), core.text);
}

export function metricsHandler(m: EdgeMetrics, core: Pick<CoreMetricsProxy, "text">): RequestHandler {
  return (_req, res) => {
    // Plain Node writes: Express's send/set would append "; charset=utf-8".
    res.statusCode = 200;
    res.setHeader("Content-Type", CONTENT_TYPE);
    res.end(scrapeAll(m, core));
  };
}
