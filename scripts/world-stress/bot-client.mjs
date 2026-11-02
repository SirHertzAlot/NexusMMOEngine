/** @mmo-engine/world-stress — bot client (roadmap A7).
 *
 * A single simulated player that connects to the game gateway over
 * WebSocket, authenticates, enters the world, and repeatedly sends
 * PlayerIntent messages (movement + attack) to stress the server.
 *
 * Each bot runs in its own worker_threads thread (see bot-worker.mjs),
 * so N bots = N sockets = N concurrent players.
 *
 * Protocol (docs/MESSAGE-CATALOG.md §0x05–0x06):
 *   C→S:  Hello (0x01) with credentials → Welcome (0x02) with snapshot
 *   C→S:  Intent (0x05) per tick — movement look/yaw/pitch + buttons
 *   S→C:  Snapshot (0x03), DeltaSet (0x04), Error (0x0f)
 *
 * Usage (inside a worker thread):
 *   import { BotClient } from "./bot-client.mjs";
 *   const bot = new BotClient({ url, username, password, id });
 *   await bot.connect();
 *   setInterval(() => bot.tick(), 1000 / 30); // 30 Hz intents
 */

import { WebSocket } from "ws";
import {
  encodeEnvelope,
  encodeControl,
  encodeIntentMessage,
  MessageType,
  PROTOCOL_VERSION,
  IntentButton,
} from "@mmo-engine/protocol";

const CONNECT_TIMEOUT_MS = 10000;

/** One bot: one WebSocket, one player entity, one stream of intents. */
export class BotClient {
  constructor({ url, username, password, id }) {
    this.url = url;
    this.username = username;
    this.password = password;
    this.id = id;

    this.ws = null;
    this.connected = false;
    this.authenticated = false;
    this.playerEntity = null;
    this.serverTick = 0;
    this.clientTick = 0;

    this.intentsSent = 0;
    this.intentsFailed = 0;
    this.messagesIn = 0;
    this.messagesOut = 0;
    this.errors = 0;
    this.connectedAt = null;

    this.pendingWelcome = null;
    this.pendingReject = null;
    this.connectTimer = null;
  }

  /** Open the WebSocket, send hello, resolve on welcome. */
  async connect() {
    return new Promise((resolve, reject) => {
      this.pendingWelcome = resolve;
      this.pendingReject = reject;

      this.ws = new WebSocket(this.url);
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        this.connected = true;
        this.connectedAt = Date.now();
        this.sendHello();
        this.startConnectTimer();
      };

      this.ws.onmessage = (ev) => {
        this.messagesIn++;
        const data = ev.data instanceof ArrayBuffer
          ? new Uint8Array(ev.data)
          : new Uint8Array(ev.data);
        this.handleMessage(data);
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.authenticated = false;
        this.playerEntity = null;
        this.ws = null;
        if (this.pendingReject) {
          this.pendingReject(new Error("bot: connection closed before welcome"));
          this.pendingWelcome = null;
          this.pendingReject = null;
        }
        this.stopConnectTimer();
      };

      this.ws.onerror = (err) => {
        this.errors++;
        if (this.pendingReject) {
          this.pendingReject(err);
          this.pendingWelcome = null;
          this.pendingReject = null;
        }
      };
    });
  }

  startConnectTimer() {
    this.stopConnectTimer();
    this.connectTimer = setTimeout(() => {
      if (!this.authenticated) {
        this.errors++;
        this.ws?.close();
      }
    }, CONNECT_TIMEOUT_MS);
  }

  stopConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  sendHello() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const hello = {
      protocol: PROTOCOL_VERSION,
      client: `bot-${this.username}`,
      want_snapshot: true,
      username: this.username,
      password: this.password,
    };

    this.ws.send(encodeEnvelope(MessageType.Hello, encodeControl(hello)));
    this.messagesOut++;
  }

  handleMessage(data) {
    if (data.length === 0) return;

    const type = data[0];
    const payload = data.slice(1);

    switch (type) {
      case MessageType.Welcome:
        this.handleWelcome(payload);
        break;
      case MessageType.Error:
        this.handleError(payload);
        break;
      case MessageType.Snapshot:
      case MessageType.DeltaSet:
        this.serverTick++;
        break;
      default:
        break;
    }
  }

  handleWelcome(payload) {
    try {
      const obj = JSON.parse(new TextDecoder().decode(payload));
      this.playerEntity = BigInt(obj.entity ?? 0);
      this.serverTick = obj.serverTick ?? 0;
      this.authenticated = true;
      this.stopConnectTimer();
      if (this.pendingWelcome) {
        this.pendingWelcome(obj);
        this.pendingWelcome = null;
        this.pendingReject = null;
      }
    } catch (err) {
      this.errors++;
      if (this.pendingReject) {
        this.pendingReject(err);
        this.pendingWelcome = null;
        this.pendingReject = null;
      }
    }
  }

  handleError(payload) {
    try {
      const obj = JSON.parse(new TextDecoder().decode(payload));
      this.errors++;
      console.warn(`[bot:${this.id}] server error: ${obj.message ?? obj}`);
    } catch {
      this.errors++;
    }
  }

  /** One 30 Hz step: a slow circle of movement, attack held for a second in every two. */
  tick() {
    if (!this.authenticated || !this.playerEntity) return;

    this.clientTick++;

    const t = this.clientTick * 0.1;
    const buttons =
      Math.floor(this.clientTick / 60) % 2 === 0 ? IntentButton.Attack : 0;

    this.sendIntent({
      mx: Math.sin(t) * 2,
      my: 0,
      mz: Math.cos(t) * 2,
      lookYaw: t,
      lookPitch: 0,
      jump: false,
      buttons,
    });
  }

  sendIntent(intent) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.intentsFailed++;
      return;
    }
    if (!this.playerEntity) {
      this.intentsFailed++;
      return;
    }

    try {
      const payload = encodeIntentMessage(
        BigInt(this.clientTick),
        this.playerEntity,
        intent,
      );
      this.ws.send(encodeEnvelope(MessageType.Intent, payload));
      this.messagesOut++;
      this.intentsSent++;
    } catch {
      this.intentsFailed++;
    }
  }

  getStats() {
    return {
      id: this.id,
      connected: this.connected,
      authenticated: this.authenticated,
      playerEntity: this.playerEntity ? String(this.playerEntity) : null,
      serverTick: this.serverTick,
      intentsSent: this.intentsSent,
      intentsFailed: this.intentsFailed,
      messagesIn: this.messagesIn,
      messagesOut: this.messagesOut,
      errors: this.errors,
    };
  }

  disconnect() {
    this.stopConnectTimer();
    this.connected = false;
    this.authenticated = false;
    this.ws?.close();
    this.ws = null;
  }
}
