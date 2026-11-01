/**
 * The game port (E3b of docs/EDGE-CORE-SPLIT.md): the players' WebSocket and HTTP on the public port,
 * relayed to the core over the channel, so the core binds no player port. The client connects here
 * exactly as it did to the core's own port: same frames, same /rpc/Pcg downloads. The core's end is
 * engine-core net/channel-transport.ts, which documents the packets.
 *
 * While the core is unreachable a new socket is refused (1013) and open ones close (1012, the client
 * reconnects), and HTTP answers 503.
 *
 * ponytail: open sockets don't survive a core restart (E4's degraded mode holds only the JSON router's
 * clients); holding them needs the gateway to resume sessions across a core restart.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { ChannelLike } from "@mmo-engine/channel";
import { encodeDeltaSet, encodeEnvelope, MessageType, type DeltaSetKind } from "@mmo-engine/protocol";

const EMPTY = new Uint8Array(0);

/** Largest client frame (the core's MAX_MESSAGE_BYTES). */
const MAX_MESSAGE_BYTES = 1 << 20;
/** Largest HTTP body relayed (the channel's 8 MiB frame, less base64's third). */
const MAX_HTTP_BODY_BYTES = 6 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 30_000;

export interface GameRelay {
  readonly port: number;
  /** Players' sockets open now. */
  readonly size: number;
  close(): Promise<void>;
}

interface HttpAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const toBuffer = (data: RawData): Buffer => (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer));

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_HTTP_BODY_BYTES) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function startGameRelay(channel: ChannelLike, port: number, host = "0.0.0.0"): Promise<GameRelay> {
  const edgeId = randomUUID().slice(0, 8);
  let next = 0;
  const sockets = new Map<string, WebSocket>();
  const topics = new Map<string, Set<string>>();

  channel.onPush("wire.send", (p) => {
    const { sid, data } = p as { sid: string; data: Buffer };
    const ws = sockets.get(sid);
    if (ws?.readyState === WebSocket.OPEN) ws.send(data);
  });
  channel.onPush("wire.end", (p) => {
    const { sid, code, reason } = p as { sid: string; code: number; reason: string };
    sockets.get(sid)?.close(code, reason);
  });
  channel.onPush("wire.sub", (p) => {
    const { sid, topic } = p as { sid: string; topic: string };
    if (!sockets.has(sid)) return;
    let members = topics.get(topic);
    if (!members) topics.set(topic, (members = new Set()));
    members.add(sid);
  });
  channel.onPush("wire.unsub", (p) => {
    const { sid, topic } = p as { sid: string; topic: string };
    topics.get(topic)?.delete(sid);
  });
  channel.onPush("wire.publish", (p) => {
    const { topic, data } = p as { topic: string; data: Buffer };
    const members = topics.get(topic);
    if (!members) return;
    for (const sid of members) {
      const ws = sockets.get(sid);
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
    }
  });
  // Interest management (IM4): each sector's bytes arrive once per tick; every session's DeltaSet is
  // assembled here from them (copies of shared buffers), so the core's channel cost doesn't grow with players.
  channel.onPush("wire.sectors", (p) => {
    const { tick, bytes, plans } = p as { tick: number; bytes: Record<string, Buffer>; plans: Array<{ sid: string; replace: boolean; entries: Array<[number, string, string]> }> };
    const shared = new Map<string, Uint8Array>();
    for (const [k, v] of Object.entries(bytes)) shared.set(k, v);
    for (const plan of plans) {
      const ws = sockets.get(plan.sid);
      if (ws?.readyState !== WebSocket.OPEN) continue;
      const entries = plan.entries.map(([kind, sector, key]) => ({ kind: kind as DeltaSetKind, sector, bytes: shared.get(key) ?? EMPTY }));
      ws.send(encodeEnvelope(MessageType.DeltaSet, encodeDeltaSet({ tick, replace: plan.replace, entries })));
    }
  });
  channel.onStatus((s) => {
    if (s === "down") for (const ws of sockets.values()) ws.close(1012, "server restarting");
  });

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (channel.status !== "up") {
        res.writeHead(503, { "Content-Type": "text/plain" }).end("server unavailable");
        return;
      }
      const body = await readBody(req);
      if (body === null) {
        res.writeHead(413, { "Content-Type": "text/plain" }).end("body too large");
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      try {
        const a = (await channel.request(
          "http",
          { method: req.method ?? "GET", url: req.url ?? "/", headers, body: body.toString("base64") },
          `http-${edgeId}-${next++}`,
          HTTP_TIMEOUT_MS,
        )) as HttpAnswer;
        res.writeHead(a.status, a.headers).end(Buffer.from(a.body, "base64"));
      } catch {
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" }).end("server error");
      }
    })();
  });
  const conns = new Set<Socket>();
  server.on("connection", (c: Socket) => {
    conns.add(c);
    c.once("close", () => conns.delete(c));
  });

  const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });
  wss.on("connection", (ws, req) => {
    if (channel.status !== "up") {
      ws.close(1013, "server unavailable");
      return;
    }
    const sid = `${edgeId}-${next++}`;
    sockets.set(sid, ws);
    channel.notify("wire.open", { sid, ip: req.socket.remoteAddress ?? "unknown" });
    ws.on("message", (data) => channel.notify("wire.msg", { sid, data: toBuffer(data) }));
    ws.on("close", () => {
      sockets.delete(sid);
      for (const members of topics.values()) members.delete(sid);
      channel.notify("wire.close", { sid });
    });
    ws.on("error", () => {
      /* the close event follows */
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    get size() {
      return sockets.size;
    },
    async close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      for (const c of conns) c.destroy();
      await closed;
    },
  };
}
