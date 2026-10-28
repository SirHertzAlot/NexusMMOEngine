/** Core side of the channel: answers requests and pushes to every connected edge. */
import { createServer, type Socket } from "node:net";
import { encodeFrame, FrameReader, FrameTooLargeError } from "./framing.js";
import type { ChannelObservers } from "./metrics.js";
import type { ChannelPacket } from "./types.js";

export interface ChannelServer {
  /** The bound port (useful when serving on port 0). */
  readonly port: number;
  pushToAll(type: string, payload: unknown): void;
  close(): Promise<void>;
}

const SIDE = { side: "core" } as const;

/** `onEdgeClosed` runs when an edge's connection goes away (the core ends what that edge held). */
export function serveChannel(port: number, handler: (p: ChannelPacket) => Promise<unknown>, host = "127.0.0.1", obs: ChannelObservers = {}, onEdgeClosed?: () => void): Promise<ChannelServer> {
  const sockets = new Set<Socket>();
  let counter = 0;
  const m = obs.metrics;
  const oversized = (err: unknown): void => {
    if (err instanceof FrameTooLargeError) obs.log?.log("error", "frame.oversized", { bytes: err.bytes });
  };
  const write = (socket: Socket, frame: Buffer): void => {
    m?.bytesSent.inc(SIDE, frame.length);
    socket.write(frame);
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    const reader = new FrameReader();
    const send = (obj: unknown): void => {
      if (socket.destroyed) return;
      try {
        write(socket, encodeFrame(obj));
      } catch (err) {
        oversized(err);
        throw err;
      }
    };

    socket.on("data", (chunk: Buffer) => {
      m?.bytesReceived.inc(SIDE, chunk.length);
      let frames: unknown[];
      try {
        frames = reader.push(chunk);
      } catch (err) {
        oversized(err);
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
        m?.requests.inc(SIDE);
        const started = performance.now();
        Promise.resolve()
          .then(() => handler(packet))
          .then(
            (result) => {
              m?.latency.observe(performance.now() - started, SIDE);
              send({ type: packet.type, id: packet.id, payload: result });
            },
            (err: unknown) => {
              m?.errors.inc(SIDE);
              send({ type: packet.type, id: packet.id, payload: null,
                error: String(err && (err as Error).message ? (err as Error).message : err) });
            },
          )
          .catch(() => socket.destroy()); // an unencodable result
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      onEdgeClosed?.();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : port,
        pushToAll(type, payload) {
          let frame: Buffer;
          try {
            frame = encodeFrame({ type, id: "push-" + (counter++), payload });
          } catch (err) {
            oversized(err);
            throw err;
          }
          m?.pushes.inc({ side: "core", type });
          for (const s of sockets) if (!s.destroyed) write(s, frame);
        },
        close() {
          for (const s of sockets) s.destroy();
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
  });
}
