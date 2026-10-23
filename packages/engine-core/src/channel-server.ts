/**
 * The core's end of the edge/core channel (slice E3 of
 * docs/EDGE-CORE-SPLIT.md). With MMO_EDGE=1 the players' sockets come
 * through it too (E3b: the `wire.*` and `http` packets, an EdgeRelay);
 * otherwise players connect to the gateway directly and this serves the
 * edge beside it.
 *
 * Requests: player.intent, auth.login, session.validate, core.sync,
 * mythic.grant_item, mythic.spawn_boss, metrics.get. Pushes every tick:
 * tick.events. Players' deltas and snapshots reach the edge as relayed
 * `wire.*` frames (E3b), so the old base64 tick.delta / snapshot mirror
 * stream is gone.
 *
 * metrics.get answers the core registry's Prometheus text (E6): the
 * `mmo_core_*` metrics and the channel's core side. The edge folds it into
 * its own `GET /metrics`.
 */
import { channelMetrics, serveChannel, type ChannelMetrics, type ChannelPacket, type ChannelServer } from "@mmo-engine/channel";
import { netLogger, Registry, type Counter, type Gauge, type Histogram } from "@mmo-engine/nethealth";
import type { GatewayTick } from "./net/gateway.js";

/** CORE_CHANNEL_PORT, parsed like the edge's config (copied, not imported). */
export function coreChannelPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CORE_CHANNEL_PORT ?? "4000";
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid port in CORE_CHANNEL_PORT: ${raw}`);
  return n;
}

/** What the channel needs from the running core; the Gateway provides all of it. */
export interface CoreChannelHost {
  readonly serverTick: number;
  addTickListener(cb: (t: GatewayTick) => void): void;
  /** Each tick's wall time in ms; without it `tick_duration_ms` stays empty. */
  addTickTimeListener?(cb: (ms: number) => void): void;
  channelLogin(username: string, password: string): Promise<{ ok: true; token: string; playerId: string } | { ok: false; reason: string }>;
  sessionUser(token: string): { username: string } | null;
  liveSessionTokens(): string[];
  queueTokenIntent(token: string, intent: IntentPayload): "ok" | "no_session" | "no_player" | "bad_intent";
}

export interface IntentPayload { mx: number; my: number; mz: number; lookYaw: number; lookPitch: number; jump: boolean; buttons: number; }

/** Mythic outcomes (Q9) applied through the core's own item and spawn paths, once that slice wires them. */
export interface MythicHooks {
  grantItem?(p: { playerId: string; itemId: string; instanceId: string; stats: unknown }): Promise<void> | void;
  spawnBoss?(p: { bossId: string; instanceId: string; placeId: string; stats: unknown }): Promise<void> | void;
}

export interface CoreChannel {
  readonly server: ChannelServer;
  readonly metrics: CoreMetrics;
  close(): Promise<void>;
}

/** Every `mmo_core_*` metric the core registers. */
export const CORE_METRIC_NAMES = [
  "mmo_core_tick",
  "mmo_core_tick_duration_ms",
  "mmo_core_tick_events_pushed_total",
  "mmo_core_intents_accepted_total",
] as const;

export interface CoreMetrics {
  readonly registry: Registry;
  readonly channel: ChannelMetrics;
  tick: Gauge;
  tickDuration: Histogram;
  tickEventsPushed: Counter;
  intentsAccepted: Counter;
}

export function createCoreMetrics(): CoreMetrics {
  const registry = new Registry("mmo_");
  return {
    registry,
    tick: registry.gauge("core_tick", "Last completed server tick."),
    tickDuration: registry.histogram("core_tick_duration_ms", "Wall time of each server tick in ms (budget 33.3 ms at 30 Hz)."),
    tickEventsPushed: registry.counter("core_tick_events_pushed_total", "tick.events pushes sent to the edge."),
    intentsAccepted: registry.counter("core_intents_accepted_total", "player.intent packets accepted over the channel."),
    channel: channelMetrics(registry),
  };
}

function obj(p: unknown): Record<string, unknown> {
  if (typeof p !== "object" || p === null || Array.isArray(p)) throw new Error("payload must be an object");
  return p as Record<string, unknown>;
}
function str(o: Record<string, unknown>, k: string, max = 256): string {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new Error(`payload.${k} must be a string of 1-${max} chars`);
  return v;
}
function intentOf(v: unknown): IntentPayload {
  const o = obj(v);
  const num = (k: string): number => {
    const n = o[k] ?? 0;
    if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`intent.${k} must be a finite number`);
    return n;
  };
  const buttons = num("buttons");
  if (!Number.isInteger(buttons) || buttons < 0 || buttons > 0xffff) throw new Error("intent.buttons must be an integer 0-65535");
  return { mx: num("mx"), my: num("my"), mz: num("mz"), lookYaw: num("lookYaw"), lookPitch: num("lookPitch"), jump: o.jump === true, buttons };
}

/** The players' sockets and HTTP relayed by the edge (E3b, net/channel-transport.ts): undefined for packets that aren't its. */
export interface EdgeRelay {
  handle(p: ChannelPacket): Promise<unknown> | undefined;
  edgeGone(): void;
}

export function createCoreChannelHandler(host: CoreChannelHost, mythic: MythicHooks, metrics: CoreMetrics, relay?: EdgeRelay) {
  return async (p: ChannelPacket): Promise<unknown> => {
    const relayed = relay?.handle(p);
    if (relayed !== undefined) return relayed;
    switch (p.type) {
      case "player.intent": {
        const o = obj(p.payload);
        const result = host.queueTokenIntent(str(o, "token", 128), intentOf(o.intent));
        // A refusal is an answer, not a failure: the edge maps channel
        // failures to core.unavailable, which would misreport it.
        if (result !== "ok") return { accepted: false, reason: result, tick: host.serverTick };
        metrics.intentsAccepted.inc();
        return { accepted: true, tick: host.serverTick };
      }
      case "auth.login": {
        const o = obj(p.payload);
        return host.channelLogin(str(o, "username", 64), str(o, "password", 128));
      }
      case "session.validate": {
        const token = obj(p.payload).token;
        return { valid: typeof token === "string" && host.sessionUser(token) !== null };
      }
      case "core.sync":
        return { tick: host.serverTick, sessionIds: host.liveSessionTokens() };
      case "mythic.grant_item": {
        if (!mythic.grantItem) throw new Error("mythic.grant_item is not wired on this core yet");
        const o = obj(p.payload);
        await mythic.grantItem({ playerId: str(o, "playerId"), itemId: str(o, "itemId"), instanceId: str(o, "instanceId"), stats: o.stats ?? null });
        return { ok: true };
      }
      case "mythic.spawn_boss": {
        if (!mythic.spawnBoss) throw new Error("mythic.spawn_boss is not wired on this core yet");
        const o = obj(p.payload);
        const instanceId = str(o, "instanceId");
        await mythic.spawnBoss({ bossId: str(o, "bossId"), instanceId, placeId: str(o, "placeId"), stats: o.stats ?? null });
        return { ok: true, instanceId };
      }
      case "metrics.get":
        metrics.tick.set(host.serverTick);
        return metrics.registry.scrape();
      default:
        throw new Error(`unknown packet type ${p.type}`);
    }
  };
}

/** Pushes for one finished tick: tick.events, even with no events. */
export function pushTick(push: (type: string, payload: unknown) => void, t: GatewayTick): void {
  push("tick.events", { tick: t.tick, events: t.events });
}

/** Serve the channel on `port` (loopback) and stream the host's ticks to every edge. */
export async function startCoreChannel(host: CoreChannelHost, port: number, mythic: MythicHooks = {}, metrics: CoreMetrics = createCoreMetrics(), relay?: EdgeRelay): Promise<CoreChannel> {
  const server = await serveChannel(port, createCoreChannelHandler(host, mythic, metrics, relay), "127.0.0.1",
    { metrics: metrics.channel, log: netLogger("core") }, () => relay?.edgeGone());
  let open = true;
  host.addTickListener((t) => {
    if (!open) return;
    pushTick((type, payload) => server.pushToAll(type, payload), t);
    metrics.tickEventsPushed.inc();
  });
  host.addTickTimeListener?.((ms) => { if (open) metrics.tickDuration.observe(ms); });
  return {
    server,
    metrics,
    close: () => { open = false; return server.close(); },
  };
}
