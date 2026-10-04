/**
 * Channel metrics (E6), `mmo_channel_*`, labelled `side="edge"|"core"`.
 * Register them once per process registry and hand the result to
 * ChannelClient / serveChannel; both work without it.
 */
import type { Counter, Histogram, NetLogger, Registry } from "@mmo-engine/nethealth";

export type ChannelSide = "edge" | "core";

export interface ChannelMetrics {
  requests: Counter;
  timeouts: Counter;
  errors: Counter;
  latency: Histogram;
  pushes: Counter;
  bytesSent: Counter;
  bytesReceived: Counter;
  reconnects: Counter;
  heartbeatMissed: Counter;
}

export function channelMetrics(reg: Registry): ChannelMetrics {
  return {
    requests: reg.counter("channel_requests_total", "Channel requests: sent by the edge, answered by the core.", ["side"]),
    timeouts: reg.counter("channel_timeouts_total", "Channel requests that timed out waiting for an answer.", ["side"]),
    errors: reg.counter("channel_errors_total", "Channel requests that failed: an error answer, a handler throw, or the channel dropping.", ["side"]),
    latency: reg.histogram("channel_request_latency_ms", "Channel request latency in ms: round trip on the edge, handler time on the core.", ["side"]),
    pushes: reg.counter("channel_pushes_total", "Pushes by type: received on the edge, sent by the core.", ["side", "type"]),
    bytesSent: reg.counter("channel_bytes_sent_total", "Bytes written to the channel, frame headers included.", ["side"]),
    bytesReceived: reg.counter("channel_bytes_received_total", "Bytes read from the channel.", ["side"]),
    reconnects: reg.counter("channel_reconnects_total", "Reconnect attempts after the channel dropped.", ["side"]),
    heartbeatMissed: reg.counter("channel_heartbeat_missed_total", "Heartbeat intervals that passed with nothing received.", ["side"]),
  };
}

/** What ChannelClient and serveChannel accept for observability. */
export interface ChannelObservers { metrics?: ChannelMetrics; log?: NetLogger; }
