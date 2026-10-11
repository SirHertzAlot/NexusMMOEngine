/**
 * Runs inputs against a SCRATCH server: a fresh data dir under the OS temp
 * dir, its own port and its own login, never the editor's play-mode server
 * and never real data. The server is the built engine-core server (the same
 * one Play runs); a bot connects over the same mirror client the game uses.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSocket, MirrorClient } from "@mmo-engine/mirror";
import { execInputs, type BotSession, type ExecResult } from "./playtest-exec.js";
import type { PlaytestAssertion, ReplayInput } from "./playtest-model.js";

export interface RunSpec {
  seed: number;
  bots: number;
  durationTicks: number;
  inputs: ReplayInput[];
  assertions: PlaytestAssertion[];
}

export type ScratchRunner = (spec: RunSpec) => Promise<ExecResult & { wallMs: number }>;

const LISTEN_RE = /listening on ws:\/\/[^:]+:(\d+)/;
const READY_MS = 120_000;
const TICK_HZ = 30;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let err = "";
    c.stderr?.on("data", (d: Buffer) => (err += d.toString("utf8")));
    const t = setTimeout(() => c.kill(), 60_000);
    c.on("exit", (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error(`${args[0]} exited ${code}: ${err.slice(-400)}`));
    });
    c.on("error", reject);
  });
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const t = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    child.kill();
  });
}

function sessionOf(client: MirrorClient, hooks: { tick: Array<(t: number) => void>; err: Array<(m: string) => void>; close: Array<() => void> }): BotSession {
  return {
    onTick: (cb) => void hooks.tick.push(cb),
    onError: (cb) => void hooks.err.push(cb),
    onClose: (cb) => void hooks.close.push(cb),
    sendIntent: (i) => client.sendIntent(i),
    chat: (channel, text) => client.chat(channel, text),
    admin: async (command, args) => {
      const r = await client.admin(command, args);
      return { ok: r.ok, message: r.message };
    },
    position: () => {
      const t = client.playerEntity === null ? undefined : client.state.get(client.playerEntity)?.transform;
      return t ? { x: t.px, z: t.pz } : null;
    },
  };
}

/** Builds the runner for a repo. Throws a plain message when the server is not built. */
export function createScratchRunner(repoRoot: string): ScratchRunner {
  return async (spec) => {
    const serverJs = join(repoRoot, "packages", "engine-core", "dist", "src", "server.js");
    const seedJs = join(repoRoot, "packages", "engine-core", "dist", "src", "auth", "seed-user.js");
    if (!existsSync(serverJs) || !existsSync(seedJs)) throw new Error("the game server is not built; run `npm run build --workspace=@mmo-engine/engine-core`");
    const started = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "mmo-playtest-"));
    const username = `bot-${randomBytes(3).toString("hex")}`;
    const password = randomBytes(12).toString("hex");
    const cwd = join(repoRoot, "packages", "engine-core");
    let child: ChildProcess | null = null;
    let client: MirrorClient | null = null;
    try {
      mkdirSync(dir, { recursive: true });
      await run(process.execPath, [seedJs, "--csv", join(dir, "users.csv"), username], repoRoot, { ...process.env, MMO_DEV_PASSWORD: password });
      const port = await freePort();
      child = spawn(process.execPath, [serverJs], {
        cwd,
        env: {
          ...process.env,
          MMO_PORT: String(port),
          MMO_DATA_DIR: dir,
          MMO_WORLD_SEED: String(spec.seed),
          MMO_BOTS: String(spec.bots),
          MMO_ADMINS: username,
          MMO_SCATTER: "pcg",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let output = "";
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`the scratch server did not start within ${READY_MS / 1000} s:\n${output.slice(-600)}`)), READY_MS);
        const on = (d: Buffer): void => {
          output = (output + d.toString("utf8")).slice(-4000);
          if (LISTEN_RE.test(output)) {
            clearTimeout(t);
            resolve();
          }
        };
        child?.stdout?.on("data", on);
        child?.stderr?.on("data", on);
        child?.once("exit", (code) => {
          clearTimeout(t);
          reject(new Error(`the scratch server exited (code ${code}):\n${output.slice(-600)}`));
        });
      });
      const hooks = { tick: [] as Array<(t: number) => void>, err: [] as Array<(m: string) => void>, close: [] as Array<() => void> };
      client = new MirrorClient((u) => new BrowserSocket(u), {
        onWelcome: () => {},
        onState: (t) => hooks.tick.forEach((f) => f(t)),
        onError: (e) => hooks.err.forEach((f) => f(`${e.code} ${e.message}`)),
        onClose: () => hooks.close.forEach((f) => f()),
      });
      await client.connect(`ws://127.0.0.1:${port}`, "mmo-playtest", { username, password });
      const result = await execInputs(sessionOf(client, hooks), {
        durationTicks: spec.durationTicks,
        inputs: spec.inputs,
        assertions: spec.assertions,
        timeoutMs: (spec.durationTicks / TICK_HZ) * 3000 + 20_000,
      });
      return { ...result, wallMs: Date.now() - started };
    } finally {
      client?.disconnect();
      if (child) await stop(child);
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  };
}
