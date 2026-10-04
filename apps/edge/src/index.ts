/**
 * Edge entry: `npm run server --workspace=@mmo-engine/edge`.
 *
 * The edge is the players' front door: it holds client WebSocket
 * connections and HTTP routes, and routes every packet by type through
 * `content/edge/routes.json`. Core-bound packets go over the internal
 * channel (`packages/channel`); while the core is unreachable they answer
 * `core.unavailable`.
 *
 * Environment: EDGE_HTTP_PORT (3000), EDGE_WS_PORT (3001),
 * CORE_CHANNEL_PORT (4000).
 */
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { ChannelClient } from "@mmo-engine/channel";
import { loadConfig } from "./config.js";
import { pingHandler } from "./modules/ping.js";
import { loadRoutes, routePacket, type RouterCtx } from "./router.js";

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

// 4. modules (local:<name> destinations)
const channel = new ChannelClient({ port: config.coreChannelPort });
channel.onStatus(() => {}); // status is polled by /health; no action needed yet (E4 wires reactions)
channel.connect().catch(err => console.error("initial channel connect failed, retrying in background:", err.message));
const ctx: RouterCtx = { channel, modules: { ping: pingHandler } };

// 2. HTTP
const app = express();
app.get("/health", (_req, res) => {
  res.json({ ok: true, core: channel.status });
});
const httpServer: Server = app.listen(config.httpPort, () => {
  console.log(`[edge] http on :${config.httpPort} (${routes.length} routes)`);
});

// 3. WebSocket
const wss = new WebSocketServer({ port: config.wsPort });
wss.on("listening", () => console.log(`[edge] ws on :${config.wsPort}`));
wss.on("connection", (socket) => {
  socket.on("message", async (data) => {
    let packet: unknown;
    try {
      packet = JSON.parse(data.toString());
    } catch {
      socket.send(JSON.stringify({ type: "error.bad_packet", id: "none", payload: { message: "invalid JSON" } }));
      return;
    }
    // Valid JSON that is not an object (a number, null) has no type: routePacket answers error.bad_packet.
    const p = (typeof packet === "object" && packet !== null ? packet : {}) as { type?: unknown; id?: unknown; payload?: unknown };
    try {
      const response = await routePacket(p, routes, ctx);
      socket.send(JSON.stringify(response));
    } catch (err) {
      // A local module threw: answer instead of leaving the client hanging.
      console.error("[edge] module error:", err);
      const id = typeof p.id === "string" ? p.id : "none";
      socket.send(JSON.stringify({ type: "error.internal", id, payload: { message: "internal error" } }));
    }
  });
});

// 5. graceful shutdown: stop accepting now, close everything after 5 s, exit 0
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[edge] ${signal}: no longer accepting; closing in ${SHUTDOWN_GRACE_MS / 1000} s`);
  httpServer.close();
  wss.close();
  channel.close();
  setTimeout(() => {
    for (const client of wss.clients) client.terminate();
    httpServer.closeAllConnections();
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
