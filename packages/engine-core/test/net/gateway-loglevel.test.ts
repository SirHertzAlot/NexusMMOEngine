/**
 * `loglevel` admin command over the wire (SAB Logging Phase 1, spec §2.4):
 * raising verbosity at runtime is one atomic write; a non-admin cannot do it;
 * and the gateway's own admin audit line goes through the log ring, not stdio.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  encodeControl,
  MessageType,
  type AdminResult,
  type ErrorMessage,
} from "@mmo-engine/protocol";
import { Gateway } from "../../src/net/gateway.js";
import {
  LogLevel,
  LogProducer,
  LogProducerClient,
  LogRingBuffer,
  LogWorkerCore,
} from "../../src/logging/index.js";
import { HeadlessClient, type HelloAuth } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

let gw: Gateway | null = null;

async function startGateway(logger: LogProducerClient, admins: string[]): Promise<string> {
  gw = new Gateway({
    clock: () => 1_000_000,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    admins,
    logger,
  });
  const port = await gw.listen();
  gw.frame(1_000_000);
  return `ws://127.0.0.1:${port}`;
}

const creds = (username: string): HelloAuth => ({ username, password: TEST_PASSWORD });

async function join(url: string, username: string): Promise<HeadlessClient> {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  await client.hello(username, creds(username));
  await snapP;
  return client;
}

async function admin(client: HeadlessClient, command: string, args?: unknown): Promise<AdminResult> {
  const resP = client.waitFor(MessageType.Admin, 1);
  client.sendRaw(MessageType.Admin, encodeControl(args === undefined ? { kind: "admin", command } : { kind: "admin", command, args }));
  const [payload] = await resP;
  return decodeControl<AdminResult>(payload);
}

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

describe("gateway: loglevel admin command", () => {
  it("an admin shows and changes thresholds; the change is one atomic write into the ring", async () => {
    const ring = new LogRingBuffer(256);
    const url = await startGateway(new LogProducerClient(LogProducer.GATEWAY, ring), ["alice"]);
    const client = await join(url, "alice");

    const shown = await admin(client, "loglevel");
    assert.equal(shown.ok, true);
    assert.match(shown.message, /sim=trace/);

    const set = await admin(client, "loglevel", { producer: "sim", level: "warn" });
    assert.equal(set.ok, true);
    assert.equal(ring.getLevelMask(LogProducer.SIM), LogLevel.WARN, "applied to the shared ring header");

    const help = await admin(client, "help");
    assert.match(help.message, /loglevel/);
    await client.close();
  });

  it("a bad level is refused with 4003 and changes nothing", async () => {
    const ring = new LogRingBuffer(256);
    const url = await startGateway(new LogProducerClient(LogProducer.GATEWAY, ring), ["alice"]);
    const client = await join(url, "alice");
    const errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "loglevel", args: { level: "loud" } }));
    const [payload] = await errP;
    assert.equal(decodeControl<ErrorMessage>(payload).code, 4003);
    assert.equal(ring.getLevelMask(LogProducer.SIM), LogLevel.TRACE);
    await client.close();
  });

  it("a non-admin cannot change log levels", async () => {
    const ring = new LogRingBuffer(256);
    const url = await startGateway(new LogProducerClient(LogProducer.GATEWAY, ring), ["alice"]);
    const client = await join(url, "user-a");
    const errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "loglevel", args: { level: "error" } }));
    const [payload] = await errP;
    assert.equal(decodeControl<ErrorMessage>(payload).code, 4003);
    assert.equal(ring.getLevelMask(LogProducer.GATEWAY), LogLevel.TRACE, "untouched");
    await client.close();
  });

  it("the gateway's admin audit goes to the ring (formatted by the worker), not stdio", async () => {
    const ring = new LogRingBuffer(256);
    const url = await startGateway(new LogProducerClient(LogProducer.GATEWAY, ring), ["alice"]);
    const client = await join(url, "alice");
    await admin(client, "whoami");

    const lines: string[] = [];
    const core = new LogWorkerCore({ ring, flushMs: 0, onBatch: (t) => lines.push(t) });
    core.pump();
    core.stop();
    const text = lines.join("\n");
    assert.match(text, /alice/);
    assert.match(text, /whoami/);
    await client.close();
  });
});
