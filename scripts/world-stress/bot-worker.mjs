/** @mmo-engine/world-stress — bot worker (roadmap A7).
 *
 * Worker thread entry point for bot clients. Each worker runs N BotClient
 * instances, each with its own WebSocket connection to the game gateway,
 * sending PlayerIntent messages at 30 Hz.
 *
 * Messages from parent:
 *   { type: "start", count, url, usernamePrefix, password, botsPerWorker }
 *   { type: "stop" }
 *   { type: "stats" }
 *
 * Messages to parent:
 *   { type: "ready", workerId, botCount }
 *   { type: "stats", workerId, stats: { connected, authenticated, intentsSent, ... } }
 *   { type: "error", workerId, message }
 */

import { parentPort, workerData } from "node:worker_threads";
import { BotClient } from "./bot-client.mjs";

const bots: BotClient[] = [];
let workerId = "worker";
let tickInterval: NodeJS.Timeout | null = null;
let statsInterval: NodeJS.Timeout | null = null;

// Handle messages from the parent thread
parentPort?.on("message", (msg: any) => {
  switch (msg.type) {
    case "start":
      workerId = msg.workerId ?? "worker";
      startBots(msg);
      break;
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

async function startBots(msg: any): Promise<void> {
  const { count, url, usernamePrefix = "bot", password = "bot", botsPerWorker = 1 } = msg;

  const totalBots = count * botsPerWorker;
  console.log(`[worker:${workerId}] starting ${totalBots} bots (${count} workers × ${botsPerWorker} bots)`);

  for (let i = 0; i < totalBots; i++) {
    const username = `${usernamePrefix}-${workerId}-${i}`;
    const bot = new BotClient({
      url,
      username,
      password,
      id: `${workerId}-${i}`,
    });

    try {
      await bot.connect();
      bots.push(bot);
    } catch (err) {
      console.error(`[worker:${workerId}] bot ${i} connect failed:`, err);
    }
  }

  console.log(`[worker:${workerId}] ${bots.length}/${totalBots} bots connected`);

  // Report ready to parent
  parentPort?.postMessage({
    type: "ready",
    workerId,
    botCount: bots.length,
  });

  // Start the tick loop at 30 Hz
  tickInterval = setInterval(() => {
    for (const bot of bots) {
      bot.tick();
    }
  }, 1000 / 30);

  // Report stats every 5 seconds
  statsInterval = setInterval(() => {
    reportStats();
  }, 5000);
}

function stopBots(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }

  for (const bot of bots) {
    bot.disconnect();
  }
  bots.length = 0;

  parentPort?.postMessage({
    type: "stopped",
    workerId,
  });
}

function reportStats(): void {
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
