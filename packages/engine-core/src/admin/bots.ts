/** @mmo-engine/engine-core — admin `bots` command (roadmap A7).
 *
 * Spawns N simulated player bots in worker_threads, each connecting to
 * the game gateway over WebSocket and sending PlayerIntent messages
 * (movement + attack) at 30 Hz. Used to stress-test the server under
 * concurrent player load.
 *
 * Each bot is a full WebSocket client: hello → welcome → per-tick intents.
 * Bots run in worker_threads so they don't block the server's tick loop.
 *
 * Builds on scripts/world-stress/bot-client.mjs and
 * scripts/world-stress/bot-worker.mjs (which start their bots from workerData).
 *
 * Admin command: `bots <count>` — spawns <count> bot workers.
 * Admin command: `bots stop` — stops all running bot workers.
 */
import { stdioError, stdioLog } from "../logging/index.js";

import { z } from "zod";
import * as fs from "node:fs";
import { Worker } from "node:worker_threads";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const BotsArgsSchema = z
  .object({
    /** Number of bot workers to spawn (each runs one bot client). */
    count: z
      .string()
      .regex(/^\d+$/)
      .transform((s) => Number(s))
      .refine((n) => n > 0 && n <= 1000, {
        message: "count must be between 1 and 1000",
      })
      .optional(),
    /** "stop" to halt all running bot workers. */
    stop: z.literal("stop").optional(),
  })
  .strict();

export type BotsArgs = z.infer<typeof BotsArgsSchema>;

/**
 * Running bot workers. Keys come from a counter that never repeats, so a
 * second `bots` run cannot overwrite (and lose) the workers of the first.
 */
const botWorkers = new Map<number, Worker>();
let nextWorkerKey = 0;

const WORKER_SCRIPT = path.join("scripts", "world-stress", "bot-worker.mjs");

/**
 * The bot worker script, found by walking up from this module to the repo
 * root, so the command works from the server's cwd or a package's.
 */
function workerScriptPath(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, WORKER_SCRIPT);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(process.cwd(), WORKER_SCRIPT);
    dir = parent;
  }
}

/** Spawn N bot worker threads, or stop the running ones. */
export function spawnBots(args: BotsArgs): { ok: boolean; message: string } {
  if (args.stop) {
    const stopped = botWorkers.size;
    for (const worker of botWorkers.values()) {
      worker.postMessage({ type: "stop" });
    }
    botWorkers.clear();
    return { ok: true, message: `stopped ${stopped} bot worker(s)` };
  }

  const count = args.count ?? 1;
  const url = process.env.BOT_WS_URL ?? "ws://localhost:7777";
  const usernamePrefix = process.env.BOT_USERNAME_PREFIX ?? "bot";
  const password = process.env.BOT_PASSWORD ?? "bot";

  let started = 0;
  for (let i = 0; i < count; i++) {
    const key = nextWorkerKey++;
    const workerId = `bots-${key}`;
    const worker = new Worker(workerScriptPath(), {
      workerData: {
        workerId,
        count: 1,
        url,
        usernamePrefix,
        password,
        botsPerWorker: 1,
      },
    });

    worker.on("message", (msg: any) => {
      if (msg.type === "ready") {
        stdioLog(
          `[admin bots] worker ${msg.workerId} ready with ${msg.botCount} bot(s)`,
        );
      } else if (msg.type === "error") {
        stdioError(`[admin bots] worker ${msg.workerId} failed: ${msg.message}`);
      }
    });

    worker.on("error", (err) => {
      stdioError(`[admin bots] worker ${workerId} error:`, err);
      botWorkers.delete(key);
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        stdioError(`[admin bots] worker ${workerId} exited with code ${code}`);
      }
      botWorkers.delete(key);
    });

    botWorkers.set(key, worker);
    started++;
  }

  return {
    ok: true,
    message: `spawned ${started} bot worker(s) connecting to ${url}`,
  };
}
