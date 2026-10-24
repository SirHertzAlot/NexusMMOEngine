/**
 * HeadlessClient — a scriptable WebSocket test client for the gateway
 * (slice 1.3). Drives the real wire protocol (envelope + JSON control +
 * FlatBuffers intents) with no browser, so the full multiplayer flow is
 * testable headlessly: hello → welcome → snapshot → deltas → intents.
 *
 * Usage:
 *   const c = new HeadlessClient();
 *   await c.connect(url);
 *   const welcome = await c.hello("alice", { username: "alice", password: "s3cret!!" });
 *   // ...later, or after a disconnect:
 *   const w2 = await c.hello("alice", { token: welcome.session_token });
 *   c.sendIntent(1n, BigInt(welcome.player_entity), { mx: 1, ... });
 *   const deltas = await c.waitFor(MessageType.Delta, 30);
 */

import { WebSocket } from "ws";
import {
  decodeControl,
  decodeDeltaSet,
  decodeEnvelope,
  DeltaSetKind,
  encodeControl,
  encodeEnvelope,
  MessageType,
  PROTOCOL_VERSION,
  type ErrorMessage,
  type HelloMessage,
  type WelcomeMessage,
} from "@mmo-engine/protocol";
import {
  decodeIntentMessage,
  encodeIntentMessage,
  type DecodedIntentMessage,
} from "../../src/net/intent.js";
import type { QueuedIntent } from "../../src/world.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function toBytes(data: WebSocket.RawData): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new Error("headless-client: unreadable frame");
}

export interface IntentInput {
  clientTick: bigint;
  entity: bigint;
  intent: QueuedIntent;
}

/**
 * Auth material for hello (auth slice): either first-contact credentials
 * or a session token from a previous welcome.
 */
export type HelloAuth =
  | { username: string; password: string }
  | { token: string }
  | { migration: string; ticket: string };

export class HeadlessClient {
  /** Auto-reply to server pings (disable to simulate a dead client). */
  autoPong = true;

  welcome: WelcomeMessage | null = null;
  lastError: ErrorMessage | null = null;
  closed = false;
  /** WebSocket close code once closed (1000 bye, 4000 dropped, 1009 too big…). */
  closeCode: number | null = null;

  private ws: WebSocket | null = null;
  private readonly received = new Map<MessageType, Uint8Array[]>();
  private readonly waiters = new Map<MessageType, Array<() => void>>();

  async connect(url: string): Promise<void> {
    if (this.ws) throw new Error("headless-client: already connected");
    this.ws = new WebSocket(url);
    this.ws.on("message", (data: WebSocket.RawData) =>
      this.onMessage(toBytes(data)),
    );
    this.ws.on("close", (code: number) => {
      this.closed = true;
      this.closeCode = code;
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("headless-client: connect timeout")),
        5000,
      );
      this.ws!.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws!.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Send hello and resolve with the welcome. Rejects if the server
   * answers with an error or closes the connection.
   */
  async hello(
    name: string,
    auth: HelloAuth,
    protocol: number = PROTOCOL_VERSION,
  ): Promise<WelcomeMessage> {
    const msg: HelloMessage = {
      protocol,
      client: name,
      want_snapshot: true,
      ...auth,
    };
    this.send(MessageType.Hello, encodeControl(msg));
    const deadline = Date.now() + 5000;
    for (;;) {
      if (this.welcome) return this.welcome;
      if (this.lastError) {
        throw new Error(
          `hello rejected: ${this.lastError.code} ${this.lastError.message}`,
        );
      }
      if (this.closed) throw new Error("hello: connection closed by server");
      if (Date.now() > deadline) {
        throw new Error("hello: timed out waiting for welcome");
      }
      await sleep(10);
    }
  }

  sendIntent(
    clientTick: bigint,
    entity: bigint,
    intent: QueuedIntent,
  ): void {
    this.send(
      MessageType.Intent,
      encodeIntentMessage(clientTick, entity, intent),
    );
  }

  sendPing(): void {
    this.send(MessageType.Ping, encodeControl({ t: Date.now() }));
  }

  sendBye(): void {
    this.send(MessageType.Bye, new Uint8Array(0));
  }

  sendRaw(type: MessageType, payload: Uint8Array): void {
    this.send(type, payload);
  }

  /**
   * Resolve with `count` more payloads of the given type. Payloads seen
   * before the call do NOT count toward the total.
   */
  async waitFor(
    type: MessageType,
    count: number,
    timeoutMs = 10000,
  ): Promise<Uint8Array[]> {
    // NOTE: record() — not `get() ?? []` — so the array we watch is the
    // same one onMessage() pushes into. A detached `?? []` would never
    // see new arrivals and the wait would time out.
    const seen = this.record(type);
    const start = seen.length;
    while (seen.length < start + count) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.removeWaiter(type, notify);
          reject(
            new Error(
              `timeout waiting for ${count}x message 0x${type.toString(16)} ` +
                `(got ${seen.length - start})`,
            ),
          );
        }, timeoutMs);
        const notify = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const list = this.waiters.get(type) ?? [];
        list.push(notify);
        this.waiters.set(type, list);
      });
    }
    return seen.slice(start, start + count);
  }

  async waitForClose(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for close");
      }
      await sleep(10);
    }
  }

  /** All payloads received so far for a message type. */
  payloads(type: MessageType): Uint8Array[] {
    return [...this.record(type)];
  }

  decodeIntents(): IntentInput[] {
    return this.payloads(MessageType.Intent).map((p) => {
      const m: DecodedIntentMessage = decodeIntentMessage(p);
      return { clientTick: m.clientTick, entity: m.entity, intent: m.intent };
    });
  }

  async close(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      const done = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        ws.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      ws.close();
      await done;
    }
    this.closed = true;
  }

  private send(type: MessageType, payload: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("headless-client: not connected");
    }
    this.ws.send(encodeEnvelope(type, payload));
  }

  private onMessage(buf: Uint8Array): void {
    const { type, payload } = decodeEnvelope(buf);
    this.record(type).push(payload);
    // A DeltaSet's entries also arrive as plain Deltas, so tests written
    // against per-tick Deltas read the same bytes (interest management).
    if (type === MessageType.DeltaSet) {
      for (const e of decodeDeltaSet(payload).entries) {
        if (e.kind !== DeltaSetKind.Leave) this.onMessage(encodeEnvelope(MessageType.Delta, e.bytes));
      }
    }

    switch (type) {
      case MessageType.Welcome:
        this.welcome = decodeControl<WelcomeMessage>(payload);
        break;
      case MessageType.Error:
        this.lastError = decodeControl<ErrorMessage>(payload);
        break;
      case MessageType.Ping:
        if (this.autoPong && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(encodeEnvelope(MessageType.Pong, payload));
        }
        break;
      default:
        break;
    }

    const waiters = this.waiters.get(type);
    if (waiters) {
      this.waiters.delete(type);
      for (const w of waiters) w();
    }
  }

  /** Canonical per-type receive list; shared by waiters and onMessage. */
  private record(type: MessageType): Uint8Array[] {
    let list = this.received.get(type);
    if (!list) {
      list = [];
      this.received.set(type, list);
    }
    return list;
  }

  private removeWaiter(type: MessageType, fn: () => void): void {    const list = this.waiters.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.waiters.delete(type);
  }
}
