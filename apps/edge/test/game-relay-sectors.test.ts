/** IM4: the edge assembles each session's DeltaSet from one wire.sectors push of shared bytes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { ChannelClient, serveChannel, type ChannelServer } from "@mmo-engine/channel";
import { decodeDeltaSet, decodeEnvelope, MessageType } from "@mmo-engine/protocol";
import { startGameRelay } from "../src/game-relay.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("wire.sectors: one push, a DeltaSet per session from the shared bytes", async () => {
  const sids: string[] = [];
  const box: { server: ChannelServer | null } = { server: null };
  box.server = await serveChannel(0, async (p) => {
    if (p.type === "wire.open") sids.push((p.payload as { sid: string }).sid);
    return null;
  });
  const channel = new ChannelClient({ port: box.server.port, heartbeatMs: 50, maxMissed: 3 });
  await channel.connect();
  const relay = await startGameRelay(channel, 0, "127.0.0.1");
  try {
    const got: Uint8Array[][] = [[], []];
    const sockets = [0, 1].map((i) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`);
      ws.on("message", (d) => got[i].push(new Uint8Array(d as Buffer)));
      return ws;
    });
    await Promise.all(sockets.map((ws) => new Promise((r) => ws.once("open", r))));
    while (sids.length < 2) await sleep(10);
    box.server.pushToAll("wire.sectors", {
      tick: 7,
      bytes: { "0:0,0": Buffer.from([1, 2]), "1:1,0": Buffer.from([3]) },
      plans: [
        { sid: sids[0], replace: false, entries: [[0, "0,0", "0:0,0"], [2, "5,5", "2:5,5"]] },
        { sid: sids[1], replace: true, entries: [[1, "1,0", "1:1,0"], [0, "0,0", "0:0,0"]] },
      ],
    });
    while (got[0].length < 1 || got[1].length < 1) await sleep(10);
    const sets = got.map((g) => {
      const env = decodeEnvelope(g[0]);
      assert.equal(env.type, MessageType.DeltaSet);
      return decodeDeltaSet(env.payload);
    });
    assert.deepEqual(sets[0].entries.map((e) => [e.kind, e.sector, [...e.bytes]]), [[0, "0,0", [1, 2]], [2, "5,5", []]]);
    assert.equal(sets[1].replace, true);
    assert.deepEqual(sets[1].entries.map((e) => [e.kind, e.sector, [...e.bytes]]), [[1, "1,0", [3]], [0, "0,0", [1, 2]]]);
    for (const ws of sockets) ws.close();
  } finally {
    await relay.close();
    channel.close();
    await box.server.close();
  }
});
