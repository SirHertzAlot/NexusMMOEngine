/**
 * The core's end of the edge/core channel (slice E3 of
 * docs/EDGE-CORE-SPLIT.md, built additively: players still connect to the
 * gateway directly, and this serves the edge beside it).
 *
 * Requests: player.intent, auth.login, session.validate, core.sync,
 * mythic.grant_item, mythic.spawn_boss, metrics.get. Pushes every tick:
 * tick.events and tick.delta; every 300th tick also snapshot.
 */
import { serveChannel, type ChannelPacket, type ChannelServer } from "@mmo-engine/channel";
import type { GatewayTick } from "./net/gateway.js";

/** The full-snapshot cadence: tick 0, 300, 600, ... */
export const SNAPSHOT_EVERY_TICKS = 300;
export function isSnapshotTick(n: number): boolean {
  return n % SNAPSHOT_EVERY_TICKS === 0;
}

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
  close(): Promise<void>;
}

/** Counters behind metrics.get until E6's registry replaces them. */
interface CoreCounters { tickEventsPushed: number; intentsAccepted: number; lastTickMs: number; }

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

export function createCoreChannelHandler(host: CoreChannelHost, mythic: MythicHooks, counters: CoreCounters) {
  return async (p: ChannelPacket): Promise<unknown> => {
    switch (p.type) {
      case "player.intent": {
        const o = obj(p.payload);
        const result = host.queueTokenIntent(str(o, "token", 128), intentOf(o.intent));
        if (result !== "ok") throw new Error(`intent refused: ${result}`);
        counters.intentsAccepted++;
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
        return [
          "# HELP mmo_core_tick Last completed server tick.",
          "# TYPE mmo_core_tick gauge",
          `mmo_core_tick ${host.serverTick}`,
          "# HELP mmo_core_tick_events_pushed_total tick.events pushes sent to the edge.",
          "# TYPE mmo_core_tick_events_pushed_total counter",
          `mmo_core_tick_events_pushed_total ${counters.tickEventsPushed}`,
          "# HELP mmo_core_intents_accepted_total player.intent packets accepted over the channel.",
          "# TYPE mmo_core_intents_accepted_total counter",
          `mmo_core_intents_accepted_total ${counters.intentsAccepted}`,
          "",
        ].join("\n");
      default:
        throw new Error(`unknown packet type ${p.type}`);
    }
  };
}

/**
 * Pushes for one finished tick: tick.events and tick.delta always (even with
 * no events), snapshot on snapshot ticks. Binary payloads travel as base64.
 */
export function pushTick(push: (type: string, payload: unknown) => void, t: GatewayTick): void {
  push("tick.events", { tick: t.tick, events: t.events });
  push("tick.delta", { tick: t.tick, delta: Buffer.from(t.delta).toString("base64") });
  if (isSnapshotTick(t.tick)) push("snapshot", { tick: t.tick, snapshot: Buffer.from(t.fullState()).toString("base64") });
}

/** Serve the channel on `port` (loopback) and stream the host's ticks to every edge. */
export async function startCoreChannel(host: CoreChannelHost, port: number, mythic: MythicHooks = {}): Promise<CoreChannel> {
  const counters: CoreCounters = { tickEventsPushed: 0, intentsAccepted: 0, lastTickMs: 0 };
  const server = await serveChannel(port, createCoreChannelHandler(host, mythic, counters));
  let open = true;
  host.addTickListener((t) => {
    if (!open) return;
    pushTick((type, payload) => server.pushToAll(type, payload), t);
    counters.tickEventsPushed++;
  });
  return {
    server,
    close: () => { open = false; return server.close(); },
  };
}
