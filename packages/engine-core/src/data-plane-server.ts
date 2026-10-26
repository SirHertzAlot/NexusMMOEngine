/**
 * Real-Time Network Ingestion Gateway (`data-plane-server.ts`)
 * (ENGINE_IMPLEMENTATION_SPEC.md §6).
 *
 * Isolates the Master Thread solely to binary WebSocket frame ingestion and worker
 * orchestration:
 * - Allocates the Master `SharedArrayBuffer` (`createSharedMemoryPlane`)
 * - Attaches the lockless `AtomicSPSCQueue` producer at `OFFSETS.RINGS`
 * - Spawns the 30Hz Simulation Worker (`sim-worker.ts`) and Embedded SurrealDB
 *   Persistence Worker (`persist-worker.ts`)
 * - Listens on `/ws/sim` via `uWebSockets.js` (with `ws` fallback), parsing raw
 *   4-byte binary frames `[Uint16 entityIndex (LE), Uint16 actionCode (LE)]` with
 *   zero JSON serialization or heap object churn, and enqueuing 32-bit packed
 *   command tokens directly into the lockless ring buffer.
 */

import { Worker } from "node:worker_threads";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DATA_PLANE_ENTITY_CAPACITY,
  OFFSETS,
  TELEMETRY_SLOTS,
  attachSharedMemoryPlane,
  createSharedMemoryPlane,
  type SharedMemoryPlaneViews,
} from "./sab-store.js";
import { AtomicSPSCQueue, packCommandToken } from "./lockless-ring.js";
import { loadUws } from "./net/transport.js";
import {
  DEFAULT_INPUT_RING_CAPACITY,
  DEFAULT_PERSIST_RING_CAPACITY,
  type SimExecutionMode,
} from "./sim-worker.js";

export const DEFAULT_DATA_PLANE_PORT = 4000;
export const WS_SIM_ROUTE = "/ws/sim";

/** Encode a single 4-byte binary frame `[Uint16 entityIndex (LE), Uint16 actionCode (LE)]`. */
export function encodeBinaryCommandFrame(entityIndex: number, actionCode: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  view.setUint16(0, entityIndex & 0xffff, true);
  view.setUint16(2, actionCode & 0xffff, true);
  return new Uint8Array(buf);
}

/** Encode a batch of `{ entityIndex, actionCode }` pairs into a contiguous binary payload (4 bytes each). */
export function encodeBinaryCommandBatch(
  commands: ReadonlyArray<{ entityIndex: number; actionCode: number }>,
): Uint8Array {
  const buf = new ArrayBuffer(commands.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    view.setUint16(i * 4, c.entityIndex & 0xffff, true);
    view.setUint16(i * 4 + 2, c.actionCode & 0xffff, true);
  }
  return new Uint8Array(buf);
}

export interface HybridDataPlaneOptions {
  port?: number;
  entityCapacity?: number;
  heapMegabytes?: number;
  inputRingCapacity?: number;
  persistRingCapacity?: number;
  sharedMemory?: SharedArrayBuffer;
  spawnWorkers?: boolean;
  spawnPersistWorker?: boolean;
  simAutoStart?: boolean;
  simMode?: SimExecutionMode;
  decodeMovementIntents?: boolean;
  useBatchDrain?: boolean;
  dbUrl?: string;
  transport?: "auto" | "uws" | "ws";
}

function resolveWorkerScript(baseName: "sim-worker" | "persist-worker"): {
  scriptPath: string;
  execArgv?: string[];
} {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, `./${baseName}.js`),
    path.resolve(here, `../dist/src/${baseName}.js`),
    path.resolve(here, `../dist/${baseName}.js`),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { scriptPath: candidate };
    }
  }
  const tsCandidate = path.resolve(here, `./${baseName}.ts`);
  return {
    scriptPath: tsCandidate,
    execArgv: ["--import", "tsx"],
  };
}

export class HybridDataPlaneServer {
  public readonly masterMemoryArena: SharedArrayBuffer;
  public readonly views: SharedMemoryPlaneViews;
  public readonly gatewayInputQueue: AtomicSPSCQueue;
  public readonly entityCapacity: number;

  public simWorker: Worker | null = null;
  public persistWorker: Worker | null = null;

  private readonly opts: HybridDataPlaneOptions;
  private uwsListenSocket: unknown = null;
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private readonly openSockets = new Set<Socket>();
  private boundPort = 0;
  private droppedFrames = 0;
  private ingestedFrames = 0;

  constructor(opts: HybridDataPlaneOptions = {}) {
    this.opts = opts;
    this.entityCapacity = opts.entityCapacity ?? DATA_PLANE_ENTITY_CAPACITY;
    this.masterMemoryArena =
      opts.sharedMemory ??
      createSharedMemoryPlane(this.entityCapacity, opts.heapMegabytes ?? 32);
    this.views = attachSharedMemoryPlane(this.masterMemoryArena, this.entityCapacity);

    const ringOffset =
      this.entityCapacity === DATA_PLANE_ENTITY_CAPACITY
        ? OFFSETS.RINGS
        : this.views.offsets.RINGS;
    this.gatewayInputQueue = new AtomicSPSCQueue(
      this.masterMemoryArena,
      ringOffset,
      opts.inputRingCapacity ?? DEFAULT_INPUT_RING_CAPACITY,
    );
  }

  public get port(): number {
    return this.boundPort;
  }

  public get stats(): {
    ingestedFrames: number;
    droppedFrames: number;
    queueDepth: number;
    tickCount: number;
    lastTickUs: number;
    maxTickUs: number;
    commandsProcessed: number;
    persistEnqueued: number;
    persistCommitted: number;
    budgetOverruns: number;
  } {
    const tel = this.views.telemetryView;
    return {
      ingestedFrames: this.ingestedFrames,
      droppedFrames: this.droppedFrames,
      queueDepth: this.gatewayInputQueue.size(),
      tickCount: Atomics.load(tel, TELEMETRY_SLOTS.TICK_COUNT),
      lastTickUs: Atomics.load(tel, TELEMETRY_SLOTS.LAST_TICK_US),
      maxTickUs: Atomics.load(tel, TELEMETRY_SLOTS.MAX_TICK_US),
      commandsProcessed: Atomics.load(tel, TELEMETRY_SLOTS.COMMANDS_PROCESSED),
      persistEnqueued: Atomics.load(tel, TELEMETRY_SLOTS.PERSIST_ENQUEUED),
      persistCommitted: Atomics.load(tel, TELEMETRY_SLOTS.PERSIST_COMMITTED),
      budgetOverruns: Atomics.load(tel, TELEMETRY_SLOTS.BUDGET_OVERRUNS),
    };
  }

  /**
   * Hot-path binary frame ingestion handler (ENGINE_IMPLEMENTATION_SPEC.md §6).
   * Accepts a 4-byte binary packet `[Uint16 entityIndex (LE), Uint16 actionCode (LE)]`
   * (or a packed batch of 4-byte frames up to 64 bytes) and enqueues into `gatewayInputQueue`.
   */
  public ingestBinaryMessage(message: ArrayBuffer, byteOffset = 0, byteLength = message.byteLength): number {
    if (byteLength < 4 || (byteLength & 3) !== 0) {
      return 0;
    }
    const view = new DataView(message, byteOffset, byteLength);
    let enqueued = 0;
    for (let pos = 0; pos + 4 <= byteLength; pos += 4) {
      const entityIndex = view.getUint16(pos, true);
      const actionCode = view.getUint16(pos + 2, true);
      const packedCommandToken = packCommandToken(entityIndex, actionCode);
      if (this.gatewayInputQueue.enqueue(packedCommandToken)) {
        this.ingestedFrames++;
        enqueued++;
      } else {
        this.droppedFrames++;
      }
    }
    return enqueued;
  }

  /** Spawn the Simulation Worker and (optionally) the Persistence Worker. */
  public async startWorkers(): Promise<void> {
    if (this.opts.spawnWorkers === false) return;

    if (!this.simWorker) {
      const { scriptPath, execArgv } = resolveWorkerScript("sim-worker");
      const worker = new Worker(scriptPath, {
        execArgv,
        workerData: {
          workerRole: "sim",
          sharedMemory: this.masterMemoryArena,
          entityCapacity: this.entityCapacity,
          inputRingCapacity: this.opts.inputRingCapacity ?? DEFAULT_INPUT_RING_CAPACITY,
          persistRingCapacity: this.opts.persistRingCapacity ?? DEFAULT_PERSIST_RING_CAPACITY,
          autoStart: this.opts.simAutoStart ?? true,
          mode: this.opts.simMode ?? "matrix",
          decodeMovementIntents: this.opts.decodeMovementIntents ?? false,
          useBatchDrain: this.opts.useBatchDrain ?? false,
        },
      });
      this.simWorker = worker;
      await new Promise<void>((resolve, reject) => {
        const onMsg = (msg: { type?: string }) => {
          if (msg?.type === "ready") {
            worker.off("message", onMsg);
            worker.off("error", onErr);
            resolve();
          }
        };
        const onErr = (err: Error) => {
          worker.off("message", onMsg);
          reject(err);
        };
        worker.on("message", onMsg);
        worker.once("error", onErr);
      });
    }

    if (this.opts.spawnPersistWorker !== false && !this.persistWorker) {
      const { scriptPath, execArgv } = resolveWorkerScript("persist-worker");
      const worker = new Worker(scriptPath, {
        execArgv,
        workerData: {
          workerRole: "persist",
          sharedMemory: this.masterMemoryArena,
          entityCapacity: this.entityCapacity,
          persistRingCapacity: this.opts.persistRingCapacity ?? DEFAULT_PERSIST_RING_CAPACITY,
          dbUrl: this.opts.dbUrl ?? "mem://",
          autoStart: true,
        },
      });
      this.persistWorker = worker;
      await new Promise<void>((resolve, reject) => {
        const onMsg = (msg: { type?: string }) => {
          if (msg?.type === "ready") {
            worker.off("message", onMsg);
            worker.off("error", onErr);
            resolve();
          }
        };
        const onErr = (err: Error) => {
          worker.off("message", onMsg);
          reject(err);
        };
        worker.on("message", onMsg);
        worker.once("error", onErr);
      });
    }
  }

  /** Start the network listener on `/ws/sim` and spawn background workers. */
  public async listen(port: number = this.opts.port ?? DEFAULT_DATA_PLANE_PORT): Promise<number> {
    await this.startWorkers();

    const transportPref = this.opts.transport ?? "auto";
    const uws = transportPref === "ws" ? null : loadUws();

    if (uws) {
      const uwsAny = uws as unknown as {
        DISABLED?: number;
        App(): {
          ws(pattern: string, behavior: Record<string, unknown>): unknown;
          listen(port: number, cb: (token: unknown) => void): unknown;
        };
        us_socket_local_port(token: unknown): number;
      };
      const app = uwsAny.App();
      app.ws(WS_SIM_ROUTE, {
        compression: uwsAny.DISABLED ?? 0,
        maxPayloadLength: 64, // Tiny binary frame allocation limit
        idleTimeout: 120,
        message: (_ws: unknown, message: ArrayBuffer, isBinary: boolean) => {
          if (!isBinary || message.byteLength < 4) return;
          this.ingestBinaryMessage(message, 0, message.byteLength);
        },
      });

      await new Promise<void>((resolve, reject) => {
        app.listen(port, (token: unknown) => {
          if (!token) {
            reject(new Error(`[Gateway] Failed to bind port ${port}`));
            return;
          }
          this.uwsListenSocket = token;
          this.boundPort = uwsAny.us_socket_local_port(token);
          resolve();
        });
      });
      return this.boundPort;
    }

    // Fallback to pure-JS `ws` when requested or when uWS binary is unavailable
    const server = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    server.on("connection", (sock: Socket) => {
      this.openSockets.add(sock);
      sock.once("close", () => this.openSockets.delete(sock));
    });
    const wss = new WebSocketServer({
      server,
      path: WS_SIM_ROUTE,
      maxPayload: 64,
    });
    wss.on("connection", (ws: WebSocket) => {
      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (!isBinary) return;
        if (data instanceof ArrayBuffer) {
          this.ingestBinaryMessage(data, 0, data.byteLength);
        } else if (Buffer.isBuffer(data)) {
          this.ingestBinaryMessage(
            data.buffer as ArrayBuffer,
            data.byteOffset,
            data.byteLength,
          );
        }
      });
    });

    this.httpServer = server;
    this.wss = wss;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, () => resolve());
    });
    this.boundPort = (server.address() as AddressInfo | null)?.port ?? port;
    return this.boundPort;
  }

  /** Trigger a deterministic single tick on the Simulation Worker and wait for completion. */
  public async stepSimWorker(dt?: number): Promise<void> {
    const worker = this.simWorker;
    if (!worker) throw new Error("simWorker is not running");
    await new Promise<void>((resolve, reject) => {
      const onMsg = (msg: { type?: string }) => {
        if (msg?.type === "stepped") {
          worker.off("message", onMsg);
          worker.off("error", onErr);
          resolve();
        }
      };
      const onErr = (err: Error) => {
        worker.off("message", onMsg);
        reject(err);
      };
      worker.on("message", onMsg);
      worker.once("error", onErr);
      worker.postMessage({ type: "step", dt });
    });
  }

  /** Trigger a deterministic drain on the Persistence Worker and wait for completion. */
  public async flushPersistWorker(): Promise<number> {
    const worker = this.persistWorker;
    if (!worker) throw new Error("persistWorker is not running");
    return await new Promise<number>((resolve, reject) => {
      const onMsg = (msg: { type?: string; count?: number }) => {
        if (msg?.type === "drained") {
          worker.off("message", onMsg);
          worker.off("error", onErr);
          resolve(msg.count ?? 0);
        }
      };
      const onErr = (err: Error) => {
        worker.off("message", onMsg);
        reject(err);
      };
      worker.on("message", onMsg);
      worker.once("error", onErr);
      worker.postMessage({ type: "drain" });
    });
  }

  /** Gracefully shut down the gateway listener and terminate background workers. */
  public async close(): Promise<void> {
    Atomics.store(this.views.telemetryView, TELEMETRY_SLOTS.SHUTDOWN_SIGNAL, 1);

    if (this.uwsListenSocket) {
      const uws = loadUws();
      uws?.us_listen_socket_close(this.uwsListenSocket);
      this.uwsListenSocket = null;
    }

    if (this.wss) {
      for (const client of this.wss.clients) client.terminate();
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      const srv = this.httpServer;
      this.httpServer = null;
      srv.closeAllConnections();
      for (const sock of this.openSockets) sock.destroy();
      this.openSockets.clear();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }

    if (this.simWorker) {
      const w = this.simWorker;
      this.simWorker = null;
      await w.terminate();
    }

    if (this.persistWorker) {
      const w = this.persistWorker;
      this.persistWorker = null;
      w.postMessage({ type: "stop" });
      await Promise.race([
        new Promise<void>((resolve) => w.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
      await w.terminate();
    }
  }
}
