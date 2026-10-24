/**
 * E5 harness: a real core process (engine-core's bench core-proc.mjs) and an
 * edge built from the edge's own modules (router, channel client, lifecycle,
 * tick buffer: what index.ts wires), instrumented at ingress and egress.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { WebSocket, WebSocketServer } from "ws";
import { ChannelClient } from "@mmo-engine/channel";
import { loadRoutes, routePacket } from "../../dist/src/router.js";
import { createCoreLifecycle } from "../../dist/src/lifecycle.js";
import { pingHandler } from "../../dist/src/modules/ping.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "../../../..");
const CORE_PROC = path.join(ROOT, "packages/engine-core/test/bench/core-proc.mjs");
export const BENCH_PASSWORD = "bench-password-1";

/** Start the core process; resolves with { proc, gatewayPort, channelPort, unhandled[] }. */
export function startCore(channelPort = 0, entities = 1000, users = 20) {
  const proc = spawn(process.execPath, [CORE_PROC, String(channelPort), String(entities), String(users)], { stdio: ["ignore", "pipe", "inherit"] });
  const unhandled = [];
  return new Promise((resolve, reject) => {
    proc.once("exit", (code) => reject(new Error("core exited early: " + code)));
    createInterface({ input: proc.stdout }).on("line", (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.unhandled) unhandled.push(msg.unhandled);
      if (msg.ready) { proc.removeAllListeners("exit"); resolve({ proc, gatewayPort: msg.gatewayPort, channelPort: msg.channelPort, unhandled }); }
    });
  });
}

export function hr() { return Number(process.hrtime.bigint()) / 1e6; } // ms

/** An instrumented edge on an ephemeral WS port. */
export async function startEdge(channelPort, { heartbeatMs = 5000, maxMissed = 3 } = {}) {
  const routes = loadRoutes(path.join(ROOT, "content/edge/routes.json"));
  const channel = new ChannelClient({ port: channelPort, heartbeatMs, maxMissed });
  const events = [];
  const lifecycle = createCoreLifecycle(channel, { log: (line) => events.push({ at: hr(), line }) });
  const ctx = { channel, modules: { ping: pingHandler } };
  const timings = { core: [], local: [] };
  const ticks = { count: 0, gaps: 0, last: -1 };
  channel.onPush("tick.events", (p) => {
    if (ticks.last >= 0 && p.tick !== ticks.last + 1) ticks.gaps++;
    ticks.last = p.tick; ticks.count++;
  });
  const coreTypes = new Set(routes.filter((r) => r.destination === "core").map((r) => r.packetType));
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once("listening", r));
  wss.on("connection", (socket) => {
    socket.on("message", async (data) => {
      const t0 = hr();
      const packet = JSON.parse(data.toString());
      const response = await routePacket(packet, routes, ctx);
      lifecycle.observe(response);
      const out = JSON.stringify(response);
      (coreTypes.has(packet.type) ? timings.core : timings.local).push(hr() - t0);
      socket.send(out);
    });
  });
  await channel.connect().catch(() => {});
  return {
    channel, lifecycle, timings, ticks, events,
    wsPort: wss.address().port,
    close() { channel.close(); for (const c of wss.clients) c.terminate(); wss.close(); },
  };
}

/** A WS client speaking the edge's JSON packets: request(type, payload) → response. */
export async function edgeClient(wsPort) {
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let n = 0;
  const pending = new Map();
  ws.on("message", (m) => {
    const p = JSON.parse(m.toString());
    const cb = pending.get(p.id);
    if (cb) { pending.delete(p.id); cb(p); }
  });
  return {
    ws,
    pendingCount: () => pending.size,
    request(type, payload = {}) {
      const id = String(++n);
      return new Promise((r) => { pending.set(id, r); ws.send(JSON.stringify({ type, id, payload })); });
    },
    close() { ws.close(); },
  };
}

/** Log in through the edge and put the character in the world on the core's gateway. */
export async function joinPlayer(client, gatewayPort, user) {
  const { HeadlessClient } = await import(path.join(ROOT, "packages/engine-core/dist/test/net/headless-client.js"));
  const { MessageType } = await import("@mmo-engine/protocol");
  const login = await client.request("auth.login", { username: user, password: BENCH_PASSWORD });
  if (!login.payload?.ok) throw new Error("login failed for " + user + ": " + JSON.stringify(login.payload));
  const gameClient = new HeadlessClient();
  await gameClient.connect(`ws://127.0.0.1:${gatewayPort}`);
  const snap = gameClient.waitFor(MessageType.Snapshot, 1);
  await gameClient.hello(user, { token: login.payload.token });
  await snap;
  return { token: login.payload.token, gameClient };
}

export const intent = (t) => ({ mx: Math.cos(t), my: 0, mz: Math.sin(t), lookYaw: t, lookPitch: 0, jump: false, buttons: 0 });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
