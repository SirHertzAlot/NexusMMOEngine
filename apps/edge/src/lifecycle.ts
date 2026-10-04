/**
 * Degraded mode and resync (slice E4 of docs/EDGE-CORE-SPLIT.md).
 *
 * While the core is down nothing changes for local routes: that is
 * degraded mode. Core-bound packets already answer `core.unavailable`
 * (router.ts). When the channel comes back the edge resyncs before it
 * reports the core up again: `core.sync`, then drop every known session
 * token the core no longer has. A failed sync leaves the core "down"; the
 * channel's reconnect loop brings the transition round again.
 *
 * Intents sent during an outage are not replayed: they are ephemeral, and
 * clients re-send after `core.unavailable` (README, client contract).
 */
import type { ChannelLike } from "@mmo-engine/channel";

export type CoreStatus = "up" | "down" | "unknown";

export interface CoreLifecycle {
  /** The core as the edge reports it: "up" only once a resync has completed. */
  readonly coreStatus: CoreStatus;
  /** Session tokens seen in successful `auth.login` answers. */
  readonly knownSessions: Set<string>;
  /** Record what a routed answer tells us (successful logins). */
  observe(response: { type: string; payload: unknown }): void;
  /** The `GET /health` body. */
  health(): { ok: true; core: CoreStatus };
  /** Resolves when the in-flight resync (if any) settles; for tests. */
  settled(): Promise<void>;
}

export interface LifecycleOptions {
  log?: (line: string) => void;
  now?: () => Date;
  syncTimeoutMs?: number;
}

export function createCoreLifecycle(channel: ChannelLike, opts: LifecycleOptions = {}): CoreLifecycle {
  const log = opts.log ?? ((line: string) => console.error(line));
  const now = opts.now ?? (() => new Date());
  const syncTimeoutMs = opts.syncTimeoutMs ?? 10000;
  const knownSessions = new Set<string>();
  let coreStatus: CoreStatus = channel.status === "up" ? "up" : channel.status;
  let last: CoreStatus = channel.status;
  let inflight: Promise<void> = Promise.resolve();

  async function resync(): Promise<void> {
    let sync: { tick: number; sessionIds: string[] };
    try {
      sync = await channel.request("core.sync", {}, "sync-" + Date.now(), syncTimeoutMs) as { tick: number; sessionIds: string[] };
      if (!sync || !Array.isArray(sync.sessionIds) || typeof sync.tick !== "number") throw new Error("malformed core.sync answer");
    } catch (err) {
      log("core resync failed at " + now().toISOString() + ": " + (err as Error).message);
      return; // stay down; no half-resync
    }
    if (channel.status !== "up") return; // dropped again while syncing
    const live = new Set(sync.sessionIds);
    for (const token of knownSessions) if (!live.has(token)) knownSessions.delete(token);
    coreStatus = "up";
    log("core resync complete at " + now().toISOString() + " tick=" + sync.tick + " sessions=" + knownSessions.size);
  }

  channel.onStatus((s) => {
    const prev = last;
    last = s;
    if (s === "down") {
      if (coreStatus !== "down") log("core channel down at " + now().toISOString());
      coreStatus = "down";
      return;
    }
    if (s === "up" && prev === "down") {
      inflight = resync();
      return;
    }
    if (s === "up") coreStatus = "up"; // first connection: nothing to reconcile
  });

  return {
    get coreStatus() { return coreStatus; },
    knownSessions,
    observe(response) {
      if (response.type !== "auth.login") return;
      const p = response.payload as { ok?: unknown; token?: unknown } | null;
      if (p && p.ok === true && typeof p.token === "string") knownSessions.add(p.token);
    },
    health: () => ({ ok: true, core: coreStatus }),
    settled: () => inflight,
  };
}
