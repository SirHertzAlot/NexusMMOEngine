/**
 * Browser-safe server-control adapter for the editor UI.
 *
 * Split out of host.ts on purpose: host.ts is a Vite PLUGIN (Node-only —
 * it spawns processes and reads the filesystem), which rollup must never
 * bundle for the browser. This module only speaks HTTP to the dev-host
 * routes, so the Play Mode panel can import it safely.
 */

import type { PlayStartOptions } from "./play-mode.js";

/** One owned play-mode server, as returned by the dev host. */
export interface PlayServerLike {
  url: string;
  pid: number;
  /** One-session dev credentials seeded by the host for this server. */
  username: string;
  password: string;
  /** Every seeded account of the session (the first is username/password). */
  accounts?: Array<{ username: string; password: string }>;
  /** The edge process runs beside the core. */
  edge?: boolean;
  /** Round-trip delay the client connections go through, ms. */
  latencyMs?: number;
}

/** What the play-start path passes the host: the Play menu's choices the server side honors. */
export type PlayServerStartOptions = PlayStartOptions;

/** Server-control surface the editor UI drives (implements ServerControl). */
export interface HostServerControl {
  start(opts?: PlayServerStartOptions): Promise<PlayServerLike>;
  stop(): Promise<void>;
  isRunning(): boolean;
  status(): Promise<{ running: boolean; pid?: number; port?: number }>;
}

/**
 * HTTP adapter over the dev-host routes. `scene` (EA6) names the scene
 * Play should run, read at each start: the host boots the server with it
 * (MMO_SCENE), using the document as given, saved or not.
 */
export function createHostServerControl(
  base = "",
  scene?: () => { name: string; doc: unknown } | null,
): HostServerControl {
  let running = false;
  return {
    async start(opts) {
      const open = scene?.() ?? null;
      const res = await fetch(`${base}/api/editor/server/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(opts?.bots !== undefined ? { bots: opts.bots } : {}),
          ...(opts?.clients !== undefined ? { clients: opts.clients } : {}),
          ...(opts?.network !== undefined ? { network: opts.network } : {}),
          ...(opts?.latencyMs !== undefined ? { latencyMs: opts.latencyMs } : {}),
          ...(opts?.fresh !== undefined ? { fresh: opts.fresh } : {}),
          ...(opts?.keep !== undefined ? { keep: opts.keep } : {}),
          ...(open ? { scene: { name: open.name, content: open.doc } } : {}),
        }),
      });
      const body = (await res.json()) as PlayServerLike & { ok: boolean; port: number; error?: string };
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? `start failed: HTTP ${res.status}`);
      }
      running = true;
      return {
        url: body.url,
        pid: body.pid,
        username: body.username,
        password: body.password,
        accounts: body.accounts,
        edge: body.edge,
        latencyMs: body.latencyMs,
      };
    },
    async stop() {
      const res = await fetch(`${base}/api/editor/server/stop`, {
        method: "POST",
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      running = false;
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? `stop failed: HTTP ${res.status}`);
      }
    },
    isRunning: () => running,
    async status() {
      const res = await fetch(`${base}/api/editor/server/status`);
      return (await res.json()) as {
        running: boolean;
        pid?: number;
        port?: number;
      };
    },
  };
}
