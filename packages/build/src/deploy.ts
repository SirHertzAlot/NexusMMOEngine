/**
 * Local deploy: swap the package into deployDir (keeping the previous
 * one as <deployDir>.prev), start it, poll the health check. On failure
 * the previous package is restored and restarted — a failed deploy
 * never leaves the local target down.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync, renameSync, cpSync } from "node:fs";
import { checkHealth } from "./health.js";

export interface DeployOptions {
  deployDir: string;
  /** Shell command run with cwd=deployDir that starts the server. */
  startCommand: string;
  healthUrl: string;
  env?: Record<string, string>;
  healthTimeoutMs?: number;
  healthRetries?: number;
  healthIntervalMs?: number;
}

export interface DeployResult {
  ok: boolean;
  rolledBack: boolean;
  /** Stop the currently running server (call when done). */
  stop: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startServer(deployDir: string, startCommand: string, env: Record<string, string>): ChildProcess {
  // detached: the whole process group can be killed (with shell:true the
  // child is a shell; killing just the shell would orphan the server).
  const child = spawn(startCommand, {
    cwd: deployDir,
    shell: true,
    detached: true,
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
  child.unref();
  return child;
}

async function stopServer(child: ChildProcess | null): Promise<void> {
  if (!child || !child.pid) return;
  // A signal-killed process reports signalCode, not exitCode — check both.
  const dead = (): boolean => child.exitCode !== null || child.signalCode !== null;
  if (dead()) return;
  const pid = child.pid;
  try {
    // Negative pid: signal the entire process group.
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 5000;
  while (!dead() && Date.now() < deadline) await sleep(50);
  if (!dead()) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function waitHealthy(url: string, timeoutMs: number, retries: number, intervalMs: number): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    if (await checkHealth(url, timeoutMs)) return true;
    await sleep(intervalMs);
  }
  return false;
}

export async function deployLocal(packageDir: string, opts: DeployOptions): Promise<DeployResult> {
  const prevDir = opts.deployDir + ".prev";
  const timeoutMs = opts.healthTimeoutMs ?? 2000;
  const retries = opts.healthRetries ?? 10;
  const intervalMs = opts.healthIntervalMs ?? 500;
  const env = opts.env ?? {};

  // Stash the previous package, if any.
  if (existsSync(prevDir)) rmSync(prevDir, { recursive: true, force: true });
  if (existsSync(opts.deployDir)) renameSync(opts.deployDir, prevDir);
  cpSync(packageDir, opts.deployDir, { recursive: true });

  let child = startServer(opts.deployDir, opts.startCommand, env);
  const healthy = await waitHealthy(opts.healthUrl, timeoutMs, retries, intervalMs);
  if (healthy) {
    if (existsSync(prevDir)) rmSync(prevDir, { recursive: true, force: true });
    return { ok: true, rolledBack: false, stop: () => stopServer(child) };
  }

  // Roll back: stop the bad one, restore the previous package, restart it.
  await stopServer(child);
  rmSync(opts.deployDir, { recursive: true, force: true });
  let rolledBack = false;
  if (existsSync(prevDir)) {
    renameSync(prevDir, opts.deployDir);
    rolledBack = true;
    child = startServer(opts.deployDir, opts.startCommand, env);
    await waitHealthy(opts.healthUrl, timeoutMs, retries, intervalMs);
  }
  return { ok: false, rolledBack, stop: () => stopServer(child) };
}
