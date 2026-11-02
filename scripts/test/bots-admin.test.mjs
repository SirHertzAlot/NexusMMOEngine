// A7: the admin `bots` command really connects bots. A fake gateway answers
// Hello with Welcome and counts Intent messages; the bot worker must start
// from its workerData, and `bots stop` must disconnect and end the workers.
import assert from "node:assert/strict";
import { once } from "node:events";
import * as path from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { WebSocketServer } from "ws";
import { MessageType, encodeControl, encodeEnvelope } from "@mmo-engine/protocol";

const ROOT = path.resolve(import.meta.dirname, "../..");
const WORKER = path.join(ROOT, "scripts/world-stress/bot-worker.mjs");

async function waitFor(check, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function fakeGateway() {
  const hellos = [];
  let intents = 0;
  const clients = new Set();
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("message", (data) => {
      const bytes = new Uint8Array(data);
      if (bytes[0] === MessageType.Hello) {
        hellos.push(JSON.parse(new TextDecoder().decode(bytes.slice(1))).username);
        ws.send(encodeEnvelope(MessageType.Welcome, encodeControl({ entity: 42, serverTick: 0 })));
      } else if (bytes[0] === MessageType.Intent) {
        intents++;
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${wss.address().port}`,
    hellos,
    intents: () => intents,
    async close() {
      for (const ws of clients) ws.terminate();
      await new Promise((r) => wss.close(r));
    },
  };
}

test("a bot worker starts its bots from workerData, sends intents, and stops on request", async () => {
  const gw = await fakeGateway();
  const messages = [];
  const worker = new Worker(WORKER, {
    workerData: {
      workerId: "t-0",
      count: 1,
      botsPerWorker: 2,
      url: gw.url,
      usernamePrefix: "bot",
      password: "bot",
    },
  });
  worker.on("message", (m) => messages.push(m));
  try {
    const ready = await waitFor(() => messages.find((m) => m.type === "ready"));
    assert.equal(ready.botCount, 2);
    assert.deepEqual([...gw.hellos].sort(), ["bot-t-0-0", "bot-t-0-1"]);
    await waitFor(() => gw.intents() >= 10);

    worker.postMessage({ type: "stop" });
    const [code] = await once(worker, "exit");
    assert.equal(code, 0);
    assert.ok(messages.some((m) => m.type === "stopped" && m.workerId === "t-0"));
  } finally {
    await worker.terminate();
    await gw.close();
  }
});

test("the admin bots command spawns connected bots and `bots stop` ends them", async () => {
  const gw = await fakeGateway();
  const saved = process.env.BOT_WS_URL;
  process.env.BOT_WS_URL = gw.url;
  try {
    const { spawnBots } = await import(path.join(ROOT, "packages/engine-core/dist/src/admin/bots.js"));

    const spawned = spawnBots({ count: 2 });
    assert.equal(spawned.ok, true);
    await waitFor(() => gw.hellos.length >= 2);
    await waitFor(() => gw.intents() >= 10);

    // A second run must not lose the first run's workers.
    const again = spawnBots({ count: 1 });
    assert.equal(again.ok, true);
    await waitFor(() => gw.hellos.length >= 3);

    const stopped = spawnBots({ stop: "stop" });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.message, "stopped 3 bot worker(s)");

    // Let intents already in flight arrive, then take the baseline.
    await new Promise((r) => setTimeout(r, 200));
    const before = gw.intents();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(gw.intents(), before, "no intents after bots stop");
  } finally {
    if (saved === undefined) delete process.env.BOT_WS_URL;
    else process.env.BOT_WS_URL = saved;
    await gw.close();
  }
});
