/**
 * Simulated latency for play clients (EA14): a TCP proxy in front of the
 * owned server that holds every chunk back by half the round-trip time in
 * each direction. WebSockets are a plain byte stream over TCP, so the
 * handshake and every frame are delayed alike and keep their order (timers
 * of equal length fire in the order they were set).
 */
import { createServer, connect, type Server, type Socket } from "node:net";

export interface LatencyProxy {
  /** The port clients connect to instead of the server's. */
  port: number;
  close(): Promise<void>;
}

export function startLatencyProxy(target: { host: string; port: number }, roundTripMs: number): Promise<LatencyProxy> {
  const oneWay = Math.max(0, roundTripMs) / 2;
  const sockets = new Set<Socket>();
  const pipe = (from: Socket, to: Socket): void => {
    from.on("data", (chunk: Buffer) => {
      setTimeout(() => {
        if (!to.destroyed) to.write(chunk);
      }, oneWay);
    });
    // Close after the delayed data, not before it.
    from.on("end", () => setTimeout(() => to.end(), oneWay));
    from.on("error", () => to.destroy());
    from.on("close", () => setTimeout(() => to.destroy(), oneWay + 50));
  };
  const server: Server = createServer((client) => {
    const upstream = connect(target.port, target.host);
    sockets.add(client).add(upstream);
    for (const s of [client, upstream]) s.on("close", () => sockets.delete(s));
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    pipe(client, upstream);
    pipe(upstream, client);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") return reject(new Error("latency proxy: no port"));
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
