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
 * scripts/world-stress/bot-worker.mjs.
 *
 * Admin command: `bots <count>` — spawns <count> bot workers.
 * Admin command: `bots stop` — stops all running bot workers.
 */

import { z } from "zod";
import { Worker } from "node:worker_threads";
import * as path from "node:path";

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

/** Active bot workers, keyed by worker index. */
const botWorkers = new Map<number, Worker>();

/** Resolve the bot worker script path. */
function workerScriptPath(): string {
  return path.resolve(process.cwd(), "scripts/world-stress/bot-worker.mjs");
}

/** Spawn N bot worker threads. */
export function spawnBots(args: BotsArgs): { ok: boolean; message: string } {
  if (args.stop) {
    for (const [idx, worker] of botWorkers) {
      worker.terminate();
      botWorkers.delete(idx);
    }
    return { ok: true, message: `stopped ${botWorkers.size} bot workers` };
  }

  const count = args.count ?? 1;
  const url = process.env.BOT_WS_URL ?? "ws://localhost:7777";
  const usernamePrefix = process.env.BOT_USERNAME_PREFIX ?? "bot";
  const password = process.env.BOT_PASSWORD ?? "bot";

  let started = 0;
  for (let i = 0; i < count; i++) {
    const worker = new Worker(workerScriptPath(), {
      workerData: {
        workerId: `bots-${i}`,
        count: 1,
        url,
        usernamePrefix,
        password,
        botsPerWorker: 1,
      },
    });

    worker.on("message", (msg: any) => {
      if (msg.type === "ready") {
        console.log(
          `[admin bots] worker ${msg.workerId} ready with ${msg.botCount} bot(s)`,
        );
      } else if (msg.type === "stats") {
        // Stats are logged periodically; could also be forwarded to admin UI
      } else if (msg.type === "stopped") {
        botWorkers.delete(Number(msg.workerId.split("-")[1]));
      }
    });

    worker.on("error", (err) => {
      console.error(`[admin bots] worker ${i} error:`, err);
      botWorkers.delete(i);
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        console.error(`[admin bots] worker ${i} exited with code ${code}`);
      }
      botWorkers.delete(i);
    });

    botWorkers.set(i, worker);
    started++;
  }

  return {
    ok: true,
    message: `spawned ${started} bot worker(s) connecting to ${url}`,
  };
}
