/**
 * Edge entry: `npm run server --workspace=@mmo-engine/edge`.
 *
 * The edge is the players' front door: it holds client WebSocket
 * connections and HTTP routes, and routes every packet by type through
 * `content/edge/routes.json`. Core-bound packets go over the internal
 * channel (`packages/channel`); while the core is unreachable they answer
 * `core.unavailable`.
 *
 * `GET /metrics` is the Prometheus scrape for the whole engine (E6,
 * metrics.ts); network lifecycle events log as JSON lines.
 *
 * With EDGE_GAME_PORT set the edge is also the players' game port (E3b,
 * game-relay.ts): their WebSocket and HTTP relayed to a core started with
 * MMO_EDGE=1, which binds no player port of its own.
 *
 * Environment: EDGE_HTTP_PORT (3000), EDGE_WS_PORT (3001),
 * CORE_CHANNEL_PORT (4000), EDGE_GAME_PORT (unset: no game port).
 */
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { ChannelClient } from "@mmo-engine/channel";
import { netLogger } from "@mmo-engine/nethealth";
import { gamePort, loadConfig } from "./config.js";
import { startGameRelay, type GameRelay } from "./game-relay.js";
import { pingHandler } from "./modules/ping.js";
import { loadRoutes, routePacket, type RouterCtx } from "./router.js";
import { EdgeRegistry, edgeModulesHandler, loadEdgeModules } from "./edge-registry.js";
import { createCoreLifecycle } from "./lifecycle.js";
import { createCoreMetricsProxy, createEdgeMetrics, metricsHandler, packetTypeLabel, recordRoute } from "./metrics.js";

/** Walks up from this file until a package.json with a `workspaces` field: the repo root. */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      const json = JSON.parse(readFileSync(pkg, "utf8")) as { workspaces?: unknown };
      if (json.workspaces !== undefined) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("findRepoRoot: no package.json with a workspaces field above " + fileURLToPath(import.meta.url));
    dir = parent;
  }
}

const SHUTDOWN_GRACE_MS = 5000;

// 1. config + routes
const config = loadConfig();
const routes = loadRoutes(join(findRepoRoot(), "content/edge/routes.json"));
const routedTypes = new Set(routes.map((r) => r.packetType));
const metrics = createEdgeMetrics();
const log = netLogger("edge");

// 4. modules (local:<name> destinations)
const channel = new ChannelClient({ port: config.coreChannelPort, metrics: metrics.channel, log: netLogger("channel") });
// E4: log outages, resync on reconnect, track sessions from logins.
const lifecycle = createCoreLifecycle(channel);
const coreMetrics = createCoreMetricsProxy(channel, metrics);
coreMetrics.start();
// Don't wait out the 15 s interval to un-stale after (re)connecting.
channel.onStatus((s) => { if (s === "up") void coreMetrics.refresh(); });
channel.connect().catch(err => console.error("initial channel connect failed, retrying in background:", err.message));
const ctx: RouterCtx = { channel, modules: { ping: pingHandler } };

// 2. HTTP
const app = express();
app.get("/health", (_req, res) => {
  res.json(lifecycle.health());
});
app.get("/metrics", metricsHandler(metrics, coreMetrics));
// EA12: edge module registry — clients discover regional edges here.
const edgeModules = loadEdgeModules(join(findRepoRoot(), "modules"), join(findRepoRoot(), "content", "modules.json"));
for (const p of edgeModules.problems) console.warn(`[edge] edge registry: ${p.module} ${p.path}: ${p.message}`);
const edgeRegistry: EdgeRegistry = edgeModules.registry;
app.get("/api/edge/modules", edgeModulesHandler(edgeRegistry));
const httpServer: Server = app.listen(config.httpPort, () => {
  console.log(`[edge] http on :${config.httpPort} (${routes.length} routes)`);
});

// 3. WebSocket
const wss = new WebSocketServer({ port: config.wsPort });
wss.on("listening", () => console.log(`[edge] ws on :${config.wsPort}`));
wss.on("connection", (socket) => {
  metrics.wsConnects.inc();
  metrics.wsConnections.inc();
  log.log("info", "ws.open", { connections: wss.clients.size });
  socket.on("close", (code) => {
    metrics.wsDisconnects.inc();
    metrics.wsConnections.dec();
    log.log("info", "ws.close", { code, connections: wss.clients.size });
  });
  socket.on("message", async (data) => {
    const started = performance.now();
    let packet: unknown;
    try {
      packet = JSON.parse(data.toString());
    } catch {
      recordRoute(metrics, "none", "error.bad_packet", performance.now() - started);
      socket.send(JSON.stringify({ type: "error.bad_packet", id: "none", payload: { message: "invalid JSON" } }));
      return;
    }
    // Valid JSON that is not an object (a number, null) has no type: routePacket answers error.bad_packet.
    const p = (typeof packet === "object" && packet !== null ? packet : {}) as { type?: unknown; id?: unknown; payload?: unknown };
    const packetType = packetTypeLabel(p.type, routedTypes);
    try {
      const response = await routePacket(p, routes, ctx);
      recordRoute(metrics, packetType, response.type, performance.now() - started);
      lifecycle.observe(response);
      socket.send(JSON.stringify(response));
    } catch (err) {
      // A local module threw: answer instead of leaving the client hanging.
      console.error("[edge] module error:", err);
      recordRoute(metrics, packetType, "error.internal", performance.now() - started);
      const id = typeof p.id === "string" ? p.id : "none";
      socket.send(JSON.stringify({ type: "error.internal", id, payload: { message: "internal error" } }));
    }
  });
});

// 3b. The players' game port (E3b): their WebSocket and HTTP relayed to the core.
const gamePortNo = gamePort();
let gameRelay: GameRelay | null = null;
if (gamePortNo !== null) {
  startGameRelay(channel, gamePortNo).then(
    (r) => {
      gameRelay = r;
      console.log(`[edge] game port :${r.port} (players relayed to the core over the channel)`);
    },
    (err: Error) => {
      console.error(`[edge] game port :${gamePortNo} not served: ${err.message}`);
      process.exit(1);
    },
  );
}

// 5. graceful shutdown: stop accepting now, close everything after 5 s, exit 0
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[edge] ${signal}: no longer accepting; closing in ${SHUTDOWN_GRACE_MS / 1000} s`);
  httpServer.close();
  wss.close();
  void gameRelay?.close();
  coreMetrics.stop();
  channel.close();
  setTimeout(() => {
    for (const client of wss.clients) client.terminate();
    httpServer.closeAllConnections();
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
