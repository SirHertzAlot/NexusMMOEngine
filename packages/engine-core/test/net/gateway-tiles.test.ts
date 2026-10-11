/**
 * On-demand chunk tiles (protocol 0x21/0x22): real Gateway + WebSocket
 * client. Tile requests are answered from the ChunkDataSource; malformed,
 * too-frequent, and oversized requests are answered 4003.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  encodeControl,
  decodeTileHeights,
  MessageType,
  type TileRequestMessage,
  type TileResponseMessage,
} from "@mmo-engine/protocol";
import { Gateway } from "../../src/net/gateway.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

let now = 0;
let gw: Gateway | null = null;

async function startGateway(opts: Record<string, unknown> = {}): Promise<string> {
  now = 1_000_000;
  const chunkSource = {
    chunkSamples: 256,
    generateChunk: (_seed: bigint, cx: number, cz: number, _lod: number, out: Float32Array) => {
      out.fill(cx * 1000 + cz);
    },
  };
  gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    chunkSource,
    worldSeed: 42n,
    ...opts,
  } as never);
  const port = await (gw as unknown as { listen(): Promise<number> }).listen();
  (gw as unknown as { frame(t: number): void }).frame(now);
  return `ws://127.0.0.1:${port}`;
}

const creds = (username: string) => ({ username, password: TEST_PASSWORD });

async function join(url: string, username: string): Promise<HeadlessClient> {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  await client.hello(username, creds(username));
  await snapP;
  return client;
}

function sendTiles(client: HeadlessClient, msg: TileRequestMessage): void {
  (client as unknown as { send(t: number, p: Uint8Array): void }).send(
    MessageType.TileRequest,
    encodeControl(msg),
  );
}

afterEach(async () => {
  if (gw) {
    await (gw as unknown as { close(): Promise<void> }).close();
    gw = null;
  }
});

describe("gateway: tile streaming (0x21/0x22)", () => {
  it("answers tile requests from the chunk source", async () => {
    const url = await startGateway();
    const client = await join(url, "alice");
    const resP = client.waitFor(MessageType.TileResponse, 1);
    sendTiles(client, { reqId: 7, keys: ["1,2", "3,4"] });
    const [payload] = await resP;
    const res = decodeControl<TileResponseMessage>(payload);
    assert.equal(res.reqId, 7);
    assert.equal(res.tiles.length, 2);
    const t = res.tiles.find((x) => x.cx === 1 && x.cz === 2)!;
    const heights = decodeTileHeights(t.heights);
    assert.equal(heights.length, 256);
    assert.ok(heights.every((h) => h === 1002)); // cx*1000+cz
  });

  it("rejects empty and oversized requests", async () => {
    const url = await startGateway();
    const client = await join(url, "user-a");
    const errP = client.waitFor(MessageType.Error, 1);
    sendTiles(client, { reqId: 1, keys: [] });
    const [payload] = await errP;
    const err = decodeControl<{ code: number }>(payload);
    assert.equal(err.code, 4003);
  });

  it("rate-limits rapid tile requests", async () => {
    const url = await startGateway();
    const client = await join(url, "user-b");
    const errP = client.waitFor(MessageType.Error, 1);
    sendTiles(client, { reqId: 1, keys: ["0,0"] });
    // Second request within 100ms: too frequent.
    sendTiles(client, { reqId: 2, keys: ["0,0"] });
    const [payload] = await errP;
    const err = decodeControl<{ code: number }>(payload);
    assert.equal(err.code, 4003);
  });

  it("answers 4003 when no chunk source is configured", async () => {
    const url = await startGateway({ chunkSource: null, worldSeed: null });
    const client = await join(url, "user-c");
    const errP = client.waitFor(MessageType.Error, 1);
    sendTiles(client, { reqId: 1, keys: ["0,0"] });
    const [payload] = await errP;
    const err = decodeControl<{ code: number }>(payload);
    assert.equal(err.code, 4003);
  });
});
