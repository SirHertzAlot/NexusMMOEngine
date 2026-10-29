/**
 * World server entry: `npm run server --workspace=@mmo-engine/world-server`.
 *
 * A small, durable, separately-deployable Express service: region
 * registry + liveness + (slice B) migration arbitration, backed by
 * SurrealDB. Transport-agnostic core; webrpc is the first adapter.
 *
 * Environment:
 *   WORLD_PORT              HTTP listen port (default 7780)
 *   WORLD_DATA_DIR          where the embedded database lives (default ./data)
 *   WORLD_DB_URL            default "surrealkv:<WORLD_DATA_DIR>/surreal":
 *                           SurrealDB embedded in this process on SurrealKV
 *                           (the SurrealDB 3.x durable engine), on disk.
 *                           "mem://" -> embedded SurrealMX, in memory only
 *                           (volatile — the embedded engine ignores the MX
 *                           persistence parameters; verified 2026-10-28);
 *                           "ws://..." -> a separate SurrealDB server — the
 *                           recommended production shape is the SurrealMX
 *                           server started by `npm run db` (MX in memory;
 *                           sync AOL + fsync on every commit + snapshots —
 *                           the blog's only configuration that survives
 *                           both process and system crashes); "mem:" -> the plain
 *                           JS in-memory store (stress runs, NOT durable).
 *   WORLD_DB_NS / WORLD_DB_DB / WORLD_DB_USER / WORLD_DB_PASS
 *   WORLD_DB_CONNECT_TIMEOUT_MS  bound on the SurrealDB connect
 *                                handshake (default 10000; unset or
 *                                not a positive finite number = default)
 *   WORLD_API_KEY           bootstrap key regions register with.
 *                           Unset = registration disabled.
 *   WORLD_HEARTBEAT_INTERVAL_MS  lease interval (default 5000)
 *   WORLD_HEARTBEAT_TIMEOUT_MS   stale reaping threshold (default 15000)
 *   WORLD_MIGRATION_TIMEOUT_MS   a hand-off not committed within this
 *                                expires; the source keeps the entity
 *                                (default 10000)
 *   WORLD_TOTAL_CHUNK_SPACE "x0,z0,x1,z1" total world chunk space the
 *                                assignment policy (P5) carves ranges
 *                                from (default "0,0,4096,4096")
 *   WORLD_HOST_REPORT_TIMEOUT_MS how long a host report stays fresh
 *                                for assignment (default: the heartbeat
 *                                timeout)
 *
 * A separate server instead: `npm run db --workspace=@mmo-engine/world-server`
 * (needs the `surreal` binary on PATH) with
 * WORLD_DB_URL=ws://127.0.0.1:8000/rpc WORLD_DB_USER=root WORLD_DB_PASS=root.
 */
import * as path from "node:path";
import * as argon2 from "argon2";
import express from "express";
import {
  LogProducer,
  LogProducerClient,
  LogRingBuffer,
  LogWorkerSupervisor,
  logWorldMigrationExpired,
  logWorldMigrationExpiryError,
  logWorldReapedStaleRegion,
  logWorldReaperError,
} from "@mmo-engine/logging/dist/src/logging/index.js";
import { createWebrpcRouter } from "./adapters/webrpc.js";
import { WorldCoreImpl } from "./core.js";
import { MemoryWorldStore } from "./fake-store.js";
import { SurrealWorldStore } from "./surreal-store.js";
import type { WorldStore } from "./types.js";

const PORT = Number(process.env.WORLD_PORT ?? 7780);
// The embedded engine wants "<engine>:" + an absolute path with forward slashes and no "//" (see engine-core world-catalog.ts).
const DB_URL = process.env.WORLD_DB_URL ?? `surrealkv:${path.resolve(process.env.WORLD_DATA_DIR ?? "./data", "surreal").split(path.sep).join("/")}`;
const HEARTBEAT_INTERVAL_MS = Number(
  process.env.WORLD_HEARTBEAT_INTERVAL_MS ?? 5000,
);
const HEARTBEAT_TIMEOUT_MS = Number(
  process.env.WORLD_HEARTBEAT_TIMEOUT_MS ?? 15000,
);
const MIGRATION_TIMEOUT_MS = Number(
  process.env.WORLD_MIGRATION_TIMEOUT_MS ?? 10000,
);
const TOTAL_WORLD_CHUNK_SPACE = (() => {
  const parts = (process.env.WORLD_TOTAL_CHUNK_SPACE ?? "0,0,4096,4096")
    .split(",")
    .map(Number);
  // Env order is "x0,z0,x1,z1", the REGION_CHUNK_RANGE convention.
  return { x0: parts[0], z0: parts[1], x1: parts[2], z1: parts[3] };
})();
const HOST_REPORT_TIMEOUT_MS = process.env.WORLD_HOST_REPORT_TIMEOUT_MS
  ? Number(process.env.WORLD_HOST_REPORT_TIMEOUT_MS)
  : undefined;
const DB_CONNECT_TIMEOUT_MS = (() => {
  const raw = process.env.WORLD_DB_CONNECT_TIMEOUT_MS;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
})();

async function makeStore(): Promise<{ store: WorldStore; close: () => Promise<void> }> {
  if (DB_URL === "mem:" || DB_URL === "") {
    console.log("[world] store=mem (non-durable; set WORLD_DB_URL for SurrealDB)");
    const store = new MemoryWorldStore();
    return { store, close: async () => {} };
  }
  const store = new SurrealWorldStore({
    url: DB_URL,
    namespace: process.env.WORLD_DB_NS ?? "mmo",
    database: process.env.WORLD_DB_DB ?? "world",
    username: process.env.WORLD_DB_USER,
    password: process.env.WORLD_DB_PASS,
    connectTimeoutMs: DB_CONNECT_TIMEOUT_MS,
  });
  await store.connect();
  console.log(`[world] store=surrealdb url=${DB_URL}`);
  return { store, close: () => store.close() };
}

async function main(): Promise<void> {
  // SAB logging layer (docs/SAB-LOGGING-LAYER-SPEC.md): the world process
  // hosts its own ring + worker on the shared dictionary (0x0500-0x05FF).
  // Boot banners and fatals stay on stdio on purpose; WORLD_LOG=0 starts no
  // worker (records are then only counted as ring drops).
  const logRing = new LogRingBuffer();
  const logSupervisor = new LogWorkerSupervisor({
    ring: logRing,
    logDir: process.env.WORLD_LOG_DIR || path.join("data", "logs"),
  });
  if (process.env.WORLD_LOG !== "0") await logSupervisor.start();
  process.on("exit", () => {
    try { logSupervisor.stopSync(); } catch { /* exiting: nothing left to protect */ }
  });
  const logger = new LogProducerClient(LogProducer.WORLD, logRing);

  const apiKey = process.env.WORLD_API_KEY;
  const apiKeyHash = apiKey ? await argon2.hash(apiKey) : null;
  if (!apiKey) {
    console.warn("[world] WORLD_API_KEY unset: region registration disabled");
  }

  const { store, close } = await makeStore();
  const core = new WorldCoreImpl({
    store,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    migrationTimeoutMs: MIGRATION_TIMEOUT_MS,
    totalWorldChunkSpace: TOTAL_WORLD_CHUNK_SPACE,
    hostReportTimeoutMs: HOST_REPORT_TIMEOUT_MS,
    apiKeyHash,
  });

  const app = express();
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.use(createWebrpcRouter(core, { logger }));

  // Stale-region reaper: runs on its own timer, never in any tick loop.
  const reaper = setInterval(async () => {
    try {
      const reaped = await core.reapStale();
      for (const id of reaped) logWorldReapedStaleRegion(logger, id);
    } catch (err) {
      logWorldReaperError(logger, err instanceof Error ? `${err.message}` : String(err));
    }
  }, Math.max(1000, Math.floor(HEARTBEAT_TIMEOUT_MS / 3)));
  reaper.unref();

  // Migration expiry (spec §6): also covers restart recovery, since a
  // migration begun before a crash is just an old `begun` row.
  const expirer = setInterval(async () => {
    try {
      for (const id of await core.expireMigrations()) logWorldMigrationExpired(logger, id);
    } catch (err) {
      logWorldMigrationExpiryError(logger, err instanceof Error ? `${err.message}` : String(err));
    }
  }, Math.max(250, Math.floor(MIGRATION_TIMEOUT_MS / 4)));
  expirer.unref();

  const server = app.listen(PORT, () => {
    console.log(`[world] listening on :${PORT} (webrpc /rpc/World/*)`);
  });

  const shutdown = async (sig: string) => {
    console.log(`[world] ${sig}: shutting down`);
    clearInterval(reaper);
    clearInterval(expirer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[world] fatal", err);
  process.exit(1);
});
