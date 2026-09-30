/**
 * MirrorClient: protocol flow over an injected fake socket.
 *
 * Covers hello (credentials + token variants), welcome, snapshot/delta
 * application, ping→pong, intent encoding, error rejection, and close.
 * The fake socket replaces the browser WebSocket (SocketLike), so the
 * whole protocol driver is testable in Node.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  decodeEnvelope,
  decodeIntentMessage,
  encodeControl,
  encodeDelta,
  encodeEnvelope,
  encodeSnapshot,
  MessageType,
  PROTOCOL_VERSION,
  type AccountMessage,
  type HelloMessage,
  type RegisterMessage,
  type WelcomeMessage,
} from "@mmo-engine/protocol";
import { MirrorClient, type MirrorEvents } from "../src/client.js";
import type { SocketLike } from "../src/socket.js";
import { emptyState, transformRow } from "./fixtures.js";

class FakeSocket implements SocketLike {
  sent: Uint8Array[] = [];
  onmessage: ((data: Uint8Array) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onopen: (() => void) | null = null;

  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.();
  }
  open(): void {
    this.onopen?.();
  }
  receive(data: Uint8Array): void {
    this.onmessage?.(data);
  }
  lastOf(type: MessageType): Uint8Array {
    const found = [...this.sent].reverse().find((d) => {
      try {
        return decodeEnvelope(d).type === type;
      } catch {
        return false;
      }
    });
    assert.ok(found, `no sent message of type ${type}`);
    return found;
  }
}

const PLAYER = 0x3001n;
const OTHER = 0x4001n;

function welcomeBytes(): Uint8Array {
  const w: WelcomeMessage = {
    protocol: PROTOCOL_VERSION,
    player_entity: PLAYER.toString(),
    server_tick: 100,
    tick_hz: 30,
    snapshot_every: 300,
    session_token: "ab".repeat(32),
  };
  return encodeEnvelope(MessageType.Welcome, encodeControl(w));
}

/** Connect a client through the fake socket; returns client + live socket. */
async function connectClient(
  auth: { username: string; password: string } | { token: string },
  events?: Partial<MirrorEvents>,
): Promise<{ client: MirrorClient; socket: FakeSocket }> {
  let socket!: FakeSocket;
  const client = new MirrorClient(() => (socket = new FakeSocket()), {
    onWelcome: events?.onWelcome ?? (() => {}),
    onState: events?.onState ?? (() => {}),
    onError: events?.onError ?? (() => {}),
    onClose: events?.onClose ?? (() => {}),
  });
  const p = client.connect("ws://localhost:7777", "test-client", auth);
  socket.open();
  // Let connect()'s continuation run: hello is sent and the welcome
  // handlers are armed before the (fake) server answers — as on a real
  // network, the welcome always follows the hello.
  await new Promise((r) => setImmediate(r));
  socket.receive(welcomeBytes());
  await p;
  return { client, socket };
}

describe("MirrorClient handshake", () => {
  it("sends a credentials hello and resolves connect on welcome", async () => {
    const { client, socket } = await connectClient({
      username: "joey",
      password: "secret",
    });
    const hello = decodeControl<HelloMessage>(
      decodeEnvelope(socket.lastOf(MessageType.Hello)).payload,
    );
    assert.equal(hello.protocol, PROTOCOL_VERSION);
    assert.equal(hello.client, "test-client");
    assert.equal(hello.want_snapshot, true);
    assert.equal(hello.username, "joey");
    assert.equal(hello.password, "secret");
    assert.equal(hello.token, undefined);

    assert.equal(client.playerEntity, PLAYER);
    assert.equal(client.serverTick, 100);
    assert.equal(client.tickHz, 30);
    assert.equal(client.sessionToken, "ab".repeat(32));
  });

  it("sends a register envelope and resolves on welcome", async () => {
    let socket!: FakeSocket;
    const client = new MirrorClient(() => (socket = new FakeSocket()), {
      onWelcome: () => {},
      onState: () => {},
      onError: () => {},
      onClose: () => {},
    });
    const p = client.register("ws://localhost:7777", "test-client", "joey", "secretpw");
    socket.open();
    // Same ordering as the real network: the register frame leaves before
    // the (fake) server answers with welcome.
    await new Promise((r) => setImmediate(r));
    socket.receive(welcomeBytes());
    const welcome = await p;

    const reg = decodeControl<RegisterMessage>(
      decodeEnvelope(socket.lastOf(MessageType.Register)).payload,
    );
    assert.equal(reg.protocol, PROTOCOL_VERSION);
    assert.equal(reg.client, "test-client");
    assert.equal(reg.username, "joey");
    assert.equal(reg.password, "secretpw");

    assert.equal(client.playerEntity, PLAYER);
    assert.equal(welcome.session_token, "ab".repeat(32));
  });

  it("sends a token hello for reconnects", async () => {
    const { socket } = await connectClient({ token: "tok".padEnd(64, "0") });
    const hello = decodeControl<HelloMessage>(
      decodeEnvelope(socket.lastOf(MessageType.Hello)).payload,
    );
    assert.equal(hello.token, "tok".padEnd(64, "0"));
    assert.equal(hello.username, undefined);
    assert.equal(hello.password, undefined);
  });

  it("fails fast with a clear reason when the server can't be reached", async () => {
    // A refused connection (server not running, wrong port) fires error and
    // close before open. That must reject immediately — not wait out the
    // 8 s open timer and report a vague "socket open timeout".
    for (const fire of ["error", "close"] as const) {
      const socket = new FakeSocket();
      const client = new MirrorClient(() => socket, {
        onWelcome() {}, onState() {}, onError() {}, onClose() {},
      });
      const started = Date.now();
      const p = client.connect("ws://127.0.0.1:7777", "t", { token: "x" });
      if (fire === "error") socket.onerror?.(new Error("ECONNREFUSED"));
      else socket.onclose?.();
      await assert.rejects(p, /could not connect to ws:\/\/127\.0\.0\.1:7777 \(is the server running\?\)/);
      assert.ok(Date.now() - started < 1000, `${fire}: rejected without waiting for the timeout`);
    }
  });

  it("rejects connect when the server answers with an error", async () => {
    let socket!: FakeSocket;
    const client = new MirrorClient(() => (socket = new FakeSocket()), {
      onWelcome: () => {},
      onState: () => {},
      onError: () => {},
      onClose: () => {},
    });
    const p = client.connect("ws://x", "test-client", {
      username: "joey",
      password: "wrong",
    });
    socket.open();
    await new Promise((r) => setImmediate(r));
    socket.receive(
      encodeEnvelope(
        MessageType.Error,
        encodeControl({ code: 4002, message: "bad credentials" }),
      ),
    );
    await assert.rejects(p, /hello rejected: 4002 bad credentials/);
    assert.equal(client.lastError?.code, 4002);
  });
});

describe("MirrorClient state sync", () => {
  it("applies a snapshot then folds a delta", async () => {
    const states: number[] = [];
    const { client, socket } = await connectClient(
      { username: "u", password: "p" },
      { onState: (t) => states.push(t) },
    );

    const s = emptyState(100);
    s.transforms = [transformRow(PLAYER, 1), transformRow(OTHER, 2)];
    socket.receive(encodeEnvelope(MessageType.Snapshot, encodeSnapshot(s)));
    assert.equal(client.state.entityCount, 2);
    assert.equal(client.state.get(PLAYER)?.transform?.px, 1);

    const d = emptyState(101, 100);
    d.transforms = [transformRow(PLAYER, 1.5)];
    d.despawned = [OTHER];
    socket.receive(encodeEnvelope(MessageType.Delta, encodeDelta(d)));
    assert.equal(client.state.entityCount, 1);
    assert.equal(client.state.get(PLAYER)?.transform?.px, 1.5);
    assert.equal(client.serverTick, 101);
    assert.deepEqual(states, [100, 101]);
  });

  it("answers ping with a pong carrying the same payload", async () => {
    const { socket } = await connectClient({ username: "u", password: "p" });
    const payload = new TextEncoder().encode(JSON.stringify({ t: 123 }));
    socket.receive(encodeEnvelope(MessageType.Ping, payload));
    const pong = decodeEnvelope(socket.lastOf(MessageType.Pong));
    assert.deepEqual(pong.payload, payload);
  });

  it("counts the bytes and messages it receives and sends", async () => {
    const { client, socket } = await connectClient({ username: "u", password: "p" });
    const sum = (list: Uint8Array[]): number => list.reduce((n, d) => n + d.byteLength, 0);
    assert.deepEqual(client.traffic, { bytesIn: welcomeBytes().byteLength, bytesOut: sum(socket.sent), messagesIn: 1, messagesOut: 1 });
    const ping = encodeEnvelope(MessageType.Ping, new Uint8Array(10));
    socket.receive(ping);
    assert.equal(client.traffic.bytesIn, welcomeBytes().byteLength + ping.byteLength);
    assert.equal(client.traffic.messagesOut, 2, "the pong");
    assert.equal(client.traffic.bytesOut, sum(socket.sent));
  });

  it("notifies onClose when the socket closes", async () => {
    let closed = 0;
    const { client, socket } = await connectClient(
      { username: "u", password: "p" },
      { onClose: () => closed++ },
    );
    client.disconnect();
    assert.equal(closed, 1);
    assert.equal(client.closed, true);
    void socket;
  });
});

describe("MirrorClient.sendIntent", () => {
  it("encodes an intent for the player entity at the last server tick", async () => {
    const { client, socket } = await connectClient({
      username: "u",
      password: "p",
    });
    client.sendIntent({
      mx: 0, my: 0, mz: -1,
      lookYaw: 0.5, lookPitch: 0.1,
      jump: true, buttons: 0,
    });
    const { payload } = decodeEnvelope(socket.lastOf(MessageType.Intent));
    const decoded = decodeIntentMessage(payload);
    assert.equal(decoded.clientTick, 100n);
    assert.equal(decoded.entity, PLAYER);
    assert.equal(decoded.intent.mz, -1);
    assert.equal(decoded.intent.lookYaw, 0.5);
    assert.equal(decoded.intent.jump, true);
  });

  it("sends one intent per server tick; a later change waits for the next tick", async () => {
    const { client, socket } = await connectClient({ username: "u", password: "p" });
    const sentIntents = () =>
      socket.sent
        .map((d) => decodeEnvelope(d))
        .filter((e) => e.type === MessageType.Intent)
        .map((e) => decodeIntentMessage(e.payload));
    const walk = (mz: number) => ({
      mx: 0, my: 0, mz, lookYaw: 0, lookPitch: 0, jump: false, buttons: 0,
    });

    client.sendIntent(walk(1)); // press W at tick 100
    client.sendIntent(walk(0.5)); // superseded before the next tick
    client.sendIntent(walk(0)); // release W, same tick
    assert.equal(sentIntents().length, 1, "the server takes one intent per tick");

    socket.receive(encodeEnvelope(MessageType.Delta, encodeDelta(emptyState(101, 100))));
    const sent = sentIntents();
    assert.equal(sent.length, 2, "the held intent goes out with the next tick");
    assert.deepEqual(
      sent.map((i) => [i.clientTick, i.intent.mz]),
      [[100n, 1], [101n, 0]],
      "newest wins, stamped with the new tick",
    );

    socket.receive(encodeEnvelope(MessageType.Delta, encodeDelta(emptyState(102, 101))));
    assert.equal(sentIntents().length, 2, "nothing held, nothing resent");
  });

  it("a press let go within one tick still reaches the server, then the release", async () => {
    const { client, socket } = await connectClient({ username: "u", password: "p" });
    const sentIntents = () =>
      socket.sent
        .map((d) => decodeEnvelope(d))
        .filter((e) => e.type === MessageType.Intent)
        .map((e) => decodeIntentMessage(e.payload).intent);
    const input = (buttons: number, jump = false) => ({
      mx: 0, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump, buttons,
    });

    client.sendIntent(input(0)); // tick 100: sent
    client.sendIntent(input(1)); // press the flight toggle
    client.sendIntent(input(0)); // and let go, all within tick 100
    client.sendIntent(input(0, true)); // a jump tap
    client.sendIntent(input(0)); // released too
    for (let t = 101; t <= 104; t++) {
      socket.receive(encodeEnvelope(MessageType.Delta, encodeDelta(emptyState(t, t - 1))));
    }
    assert.deepEqual(
      sentIntents().map((i) => [i.buttons, i.jump]),
      [[0, false], [1, false], [0, true], [0, false]],
      "every press is seen for a tick, then released",
    );
  });

  it("sends nothing before the welcome arrives", async () => {
    let socket!: FakeSocket;
    const client = new MirrorClient(() => (socket = new FakeSocket()), {
      onWelcome: () => {},
      onState: () => {},
      onError: () => {},
      onClose: () => {},
    });
    const p = client.connect("ws://x", "test-client", {
      username: "u",
      password: "p",
    });
    socket.open(); // hello sent, no welcome yet
    await new Promise((r) => setImmediate(r));
    client.sendIntent({
      mx: 0, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: false, buttons: 0,
    });
    const intents = socket.sent.filter((d) => {
      try {
        return decodeEnvelope(d).type === MessageType.Intent;
      } catch {
        return false;
      }
    });
    assert.equal(intents.length, 0);
    socket.receive(welcomeBytes());
    await p;
  });
});

describe("MirrorClient.debug (0x0a)", () => {
  it("resolves with the server's debug response", async () => {
    const { client, socket } = await connectClient({
      username: "u",
      password: "p",
    });
    const p = client.debug({ kind: "debug", query: "tiles" });
    const sent = socket.lastOf(MessageType.Debug);
    assert.deepEqual(decodeControl(decodeEnvelope(sent).payload), {
      kind: "debug",
      query: "tiles",
    });
    socket.receive(
      encodeEnvelope(
        MessageType.Debug,
        encodeControl({
          kind: "debug",
          query: "tiles",
          tiles: [[0, 0, 16, 16]],
        }),
      ),
    );
    const res = await p;
    assert.equal(res.query, "tiles");
    if (res.query === "tiles") {
      assert.deepEqual(res.tiles, [[0, 0, 16, 16]]);
    }
  });

  it("rejects when the server answers with an error", async () => {
    const { client, socket } = await connectClient({
      username: "u",
      password: "p",
    });
    const p = client.debug({
      kind: "debug",
      query: "waypoints",
      entity: "1",
    });
    socket.receive(
      encodeEnvelope(
        MessageType.Error,
        encodeControl({ code: 4003, message: "unknown debug query" }),
      ),
    );
    await assert.rejects(p, /debug rejected: 4003/);
  });

  it("rejects a second query while one is in flight, and rejects when disconnected", async () => {
    const { client } = await connectClient({
      username: "u",
      password: "p",
    });
    const first = client.debug({ kind: "debug", query: "tiles" });
    await assert.rejects(
      client.debug({ kind: "debug", query: "tiles" }),
      /already in flight/,
    );
    client.disconnect();
    await assert.rejects(first, /disconnected/);
    await assert.rejects(
      client.debug({ kind: "debug", query: "tiles" }),
      /not connected/,
    );
  });
});

describe("MirrorClient.admin (0x10)", () => {
  it("sends the command and resolves with the server's result", async () => {
    const { client, socket } = await connectClient({
      username: "u",
      password: "p",
    });
    const p = client.admin("whoami");
    const sent = socket.lastOf(MessageType.Admin);
    assert.deepEqual(decodeControl(decodeEnvelope(sent).payload), {
      kind: "admin",
      command: "whoami",
    });
    socket.receive(
      encodeEnvelope(
        MessageType.Admin,
        encodeControl({ kind: "admin", command: "whoami", ok: true, message: "admin u" }),
      ),
    );
    const res = await p;
    assert.equal(res.ok, true);
    assert.equal(res.message, "admin u");
  });

  it("rejects when the server answers with an error", async () => {
    const { client, socket } = await connectClient({
      username: "u",
      password: "p",
    });
    const p = client.admin("whoami");
    socket.receive(
      encodeEnvelope(
        MessageType.Error,
        encodeControl({ code: 4003, message: "admin only" }),
      ),
    );
    await assert.rejects(p, /admin rejected: 4003/);
  });

  it("rejects a second command while one is in flight, and rejects when disconnected", async () => {
    const { client } = await connectClient({
      username: "u",
      password: "p",
    });
    const first = client.admin("help");
    await assert.rejects(client.admin("help"), /already in flight/);
    client.disconnect();
    await assert.rejects(first, /disconnected/);
    await assert.rejects(client.admin("help"), /not connected/);
  });
});

describe("MirrorClient characters", () => {
  const LOOK = { gender: "female", parts: { head: "Chr_Head_Female_02" }, colours: { skin: "#8d5524" } };
  const account = (characters: AccountMessage["characters"], created?: number): Uint8Array =>
    encodeEnvelope(
      MessageType.Account,
      encodeControl({ session_token: "cd".repeat(32), characters, max_characters: 8, ...(created ? { created } : {}) } satisfies AccountMessage),
    );
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

  it("join → account, createCharacter → account, enterWorld → welcome", async () => {
    let socket!: FakeSocket;
    const client = new MirrorClient(() => (socket = new FakeSocket()), {
      onWelcome: () => {}, onState: () => {}, onError: () => {}, onClose: () => {},
    });
    const joined = client.join("ws://localhost:7777", "game", { username: "joey", password: "secretpw" });
    socket.open();
    await tick();
    const hello = decodeControl<HelloMessage>(decodeEnvelope(socket.lastOf(MessageType.Hello)).payload);
    assert.equal(hello.characters, true);
    socket.receive(account([]));
    const first = await joined;
    assert.equal(first.kind, "account");
    assert.equal(client.sessionToken, "cd".repeat(32));
    assert.equal(client.playerEntity, null, "not in the world yet");

    const created = client.createCharacter("Arya", LOOK);
    await tick();
    assert.deepEqual(decodeControl(decodeEnvelope(socket.lastOf(MessageType.CreateCharacter)).payload), { name: "Arya", look: LOOK });
    socket.receive(account([{ id: 7, name: "Arya", look: LOOK }], 7));
    assert.equal((await created).created, 7);
    assert.equal(client.account?.characters.length, 1);

    const entered = client.enterWorld(7);
    await tick();
    assert.deepEqual(decodeControl(decodeEnvelope(socket.lastOf(MessageType.EnterWorld)).payload), { character: 7 });
    socket.receive(welcomeBytes());
    assert.equal((await entered).player_entity, PLAYER.toString());
    assert.equal(client.playerEntity, PLAYER);
  });

  it("a refused create rejects with the reason and the connection stays usable", async () => {
    let socket!: FakeSocket;
    const client = new MirrorClient(() => (socket = new FakeSocket()), {
      onWelcome: () => {}, onState: () => {}, onError: () => {}, onClose: () => {},
    });
    const joined = client.join("ws://localhost:7777", "game", { register: { username: "joey", password: "secretpw" } });
    socket.open();
    await tick();
    assert.equal(decodeControl<RegisterMessage>(decodeEnvelope(socket.lastOf(MessageType.Register)).payload).characters, true);
    socket.receive(account([]));
    await joined;

    const refused = client.createCharacter("Hodor", LOOK);
    await tick();
    socket.receive(encodeEnvelope(MessageType.Error, encodeControl({ code: 4005, message: "that name is taken" })));
    await assert.rejects(refused, /4005 that name is taken/);
    const again = client.createCharacter("Hodora", LOOK);
    await tick();
    socket.receive(account([{ id: 2, name: "Hodora", look: LOOK }], 2));
    assert.equal((await again).created, 2);
  });
});
