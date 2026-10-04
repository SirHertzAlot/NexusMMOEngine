/** Core side of the channel: answers requests and pushes to every connected edge. */
import { createServer, type Socket } from "node:net";
import { encodeFrame, FrameReader } from "./framing.js";
import type { ChannelPacket } from "./types.js";

export interface ChannelServer {
  /** The bound port (useful when serving on port 0). */
  readonly port: number;
  pushToAll(type: string, payload: unknown): void;
  close(): Promise<void>;
}

export function serveChannel(port: number, handler: (p: ChannelPacket) => Promise<unknown>, host = "127.0.0.1"): Promise<ChannelServer> {
  const sockets = new Set<Socket>();
  let counter = 0;

  const server = createServer((socket) => {
    sockets.add(socket);
    const reader = new FrameReader();
    const send = (obj: unknown): void => { if (!socket.destroyed) socket.write(encodeFrame(obj)); };

    socket.on("data", (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const f of frames) {
        const packet = f as ChannelPacket;
        if (typeof packet !== "object" || packet === null || typeof packet.type !== "string" || typeof packet.id !== "string") {
          socket.destroy();
          return;
        }
        if (packet.type === "channel.ping") {
          send({ type: "channel.pong", id: packet.id, payload: {} });
          continue;
        }
        if (packet.id.startsWith("push-")) {
          // A notify from the edge: handled, never answered.
          Promise.resolve().then(() => handler(packet)).catch(() => {});
          continue;
        }
        Promise.resolve()
          .then(() => handler(packet))
          .then(
            (result) => send({ type: packet.type, id: packet.id, payload: result }),
            (err: unknown) => send({ type: packet.type, id: packet.id, payload: null,
              error: String(err && (err as Error).message ? (err as Error).message : err) }),
          )
          .catch(() => socket.destroy()); // an unencodable result
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : port,
        pushToAll(type, payload) {
          const frame = encodeFrame({ type, id: "push-" + (counter++), payload });
          for (const s of sockets) if (!s.destroyed) s.write(frame);
        },
        close() {
          for (const s of sockets) s.destroy();
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
  });
}
