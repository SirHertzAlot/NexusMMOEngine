/** @mmo-engine/world-stress — bot worker (roadmap A7).
 *
 * Worker thread entry point for bot clients. The worker starts its bots as
 * soon as it loads, from its workerData; each bot is its own WebSocket
 * connection to the game gateway, sending PlayerIntent messages at 30 Hz.
 *
 * workerData (set by engine-core's admin `bots` command):
 *   { workerId, count, botsPerWorker, url, usernamePrefix, password }
 *
 * Messages from parent:
 *   { type: "stop" }     disconnect every bot and exit
 *   { type: "stats" }    report stats now
 *
 * Messages to parent:
 *   { type: "ready", workerId, botCount }
 *   { type: "stats", workerId, stats: { botCount, connected, authenticated, ... } }
 *   { type: "stopped", workerId }
 */

import { parentPort, workerData } from "node:worker_threads";
import { BotClient } from "./bot-client.mjs";

const TICK_MS = 1000 / 30;
const STATS_MS = 5000;

const bots = [];
const workerId = workerData?.workerId ?? "worker";
let stopping = false;
let tickInterval = null;
let statsInterval = null;

parentPort?.on("message", (msg) => {
  switch (msg?.type) {
    case "stop":
      stopBots();
      break;
    case "stats":
      reportStats();
      break;
    default:
      break;
  }
});

async function startBots({
  count = 1,
  url,
  usernamePrefix = "bot",
  password = "bot",
  botsPerWorker = 1,
}) {
  const totalBots = count * botsPerWorker;
  console.log(`[worker:${workerId}] starting ${totalBots} bots`);

  for (let i = 0; i < totalBots && !stopping; i++) {
    const bot = new BotClient({
      url,
      username: `${usernamePrefix}-${workerId}-${i}`,
      password,
      id: `${workerId}-${i}`,
    });

    try {
      await bot.connect();
      if (stopping) {
        bot.disconnect();
        break;
      }
      bots.push(bot);
    } catch (err) {
      console.error(`[worker:${workerId}] bot ${i} connect failed:`, err);
    }
  }

  if (stopping) return;

  console.log(`[worker:${workerId}] ${bots.length}/${totalBots} bots connected`);

  parentPort?.postMessage({ type: "ready", workerId, botCount: bots.length });

  tickInterval = setInterval(() => {
    for (const bot of bots) bot.tick();
  }, TICK_MS);

  statsInterval = setInterval(reportStats, STATS_MS);
}

function stopBots() {
  if (stopping) return;
  stopping = true;

  if (tickInterval) clearInterval(tickInterval);
  if (statsInterval) clearInterval(statsInterval);
  tickInterval = null;
  statsInterval = null;

  for (const bot of bots) bot.disconnect();
  bots.length = 0;

  parentPort?.postMessage({ type: "stopped", workerId });
  // Closing the port lets the worker thread exit once its sockets have closed.
  parentPort?.close();
}

function reportStats() {
  let intentsSent = 0;
  let intentsFailed = 0;
  let messagesIn = 0;
  let messagesOut = 0;
  let errors = 0;
  let connected = 0;
  let authenticated = 0;

  for (const bot of bots) {
    const s = bot.getStats();
    intentsSent += s.intentsSent;
    intentsFailed += s.intentsFailed;
    messagesIn += s.messagesIn;
    messagesOut += s.messagesOut;
    errors += s.errors;
    if (s.connected) connected++;
    if (s.authenticated) authenticated++;
  }

  parentPort?.postMessage({
    type: "stats",
    workerId,
    stats: {
      botCount: bots.length,
      connected,
      authenticated,
      intentsSent,
      intentsFailed,
      messagesIn,
      messagesOut,
      errors,
    },
  });
}

startBots(workerData ?? {}).catch((err) => {
  console.error(`[worker:${workerId}] failed to start:`, err);
  parentPort?.postMessage({ type: "error", workerId, message: String(err) });
});
