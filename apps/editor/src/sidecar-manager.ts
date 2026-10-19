/**
 * Sidecar lifecycle for the editor dev host (roadmap EA11).
 *
 * A module may declare a `sidecar` in its manifest: a helper process (NPC
 * brain server, bake worker, telemetry collector) that runs alongside the
 * game server and is reached over localhost HTTP. The manager starts each
 * enabled module's sidecar before the game server boots, waits for its
 * health endpoint, and stops everything gracefully on shutdown.
 *
 * An unhealthy sidecar disables only its own module: the failure is logged
 * with a reason and reported per-module, and the other sidecars (and the
 * game server) start anyway. Crash isolation is the point — a dead LLM
 * server must never take the tick down with it.
 *
 * Pure lifecycle: no tick, no UI. The editor host (host.ts) wires it into
 * startOwned/stopOwned.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { get } from "node:http";
import { killProcessTree } from "./proc-tree.js";
import { WasmSidecarHost } from "./wasm-sidecar-host.js";

export type SidecarStatus = "starting" | "healthy" | "unhealthy" | "stopped";

/**
 * The slice of a discovered module the manager needs: its dir (sidecar
 * commands run with cwd here) and its sidecar declaration. Structural, so
 * callers pass @mmo-engine/modules DiscoveredModule values directly —
 * the manager never depends on the full manifest type.
 */
export interface SidecarModule {
  dir: string;
  manifest: {
    name: string;
    sidecar?:
      | { command: string; port: number; health: string }
      | { exec: string[]; port: number; health: string }
      | { wasm: string; port: number; health: string };
  };
}

export interface SidecarReport {
  name: string;
  status: SidecarStatus;
  /** Present when status is "unhealthy": why it never became ready. */
  reason?: string;
  port?: number;
}

export interface SidecarManagerOptions {
  /** How long to wait for /health to answer 200 before giving up. Default 15_000. */
  healthTimeoutMs?: number;
  /** Interval between health probes. Default 500. */
  pollIntervalMs?: number;
  /** Grace period between SIGTERM and SIGKILL on stop. Default 5_000. */
  killTimeoutMs?: number;
  /** Lifecycle + child-output lines. Defaults to a no-op (host.ts passes the server log). */
  log?: (line: string) => void;
  /**
   * Restart supervision (EA11): when a healthy sidecar exits unexpectedly,
   * restart it with exponential backoff. `maxRestarts` caps consecutive
   * restarts (0 = never restart, default 3); `baseBackoffMs` is the first
   * delay, doubled each time (default 1_000).
   */
  restartPolicy?: { maxRestarts?: number; baseBackoffMs?: number };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Never keep the host (or a test runner) alive just for a poll.
    (t as unknown as { unref?: () => void }).unref?.();
  });

export class SidecarManager {
  private readonly healthTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly killTimeoutMs: number;
  private readonly log: (line: string) => void;
  private readonly maxRestarts: number;
  private readonly baseBackoffMs: number;
  private readonly procs = new Map<string, ChildProcess>();
  private readonly statuses = new Map<string, SidecarStatus>();
  /** EA11: in-process wasm sidecars, by module name. */
  private readonly wasmHosts = new Map<string, WasmSidecarHost>();
  /** Modules by name, kept for restarts (EA11 supervision). */
  private readonly modules = new Map<string, SidecarModule>();
  /** Consecutive unexpected exits per sidecar (resets on healthy start). */
  private readonly restartCounts = new Map<string, number>();
  /** Pending restart timers per sidecar. */
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();
  /** Set when stop() is called: suppresses restarts. */
  private stopping = false;

  constructor(opts: SidecarManagerOptions = {}) {
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 15_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.killTimeoutMs = opts.killTimeoutMs ?? 5_000;
    this.log = opts.log ?? (() => {});
    this.maxRestarts = opts.restartPolicy?.maxRestarts ?? 3;
    this.baseBackoffMs = opts.restartPolicy?.baseBackoffMs ?? 1_000;
  }

  /** Last known status per sidecar name; unknown names return undefined. */
  statusOf(name: string): SidecarStatus | undefined {
    return this.statuses.get(name);
  }

  /**
   * Start the sidecar of every module that declares one, in parallel.
   * Never throws: each module gets its own report, and a failure only
   * marks that module unhealthy.
   */
  async start(modules: SidecarModule[]): Promise<SidecarReport[]> {
    const withSidecar = modules.filter((m) => m.manifest.sidecar !== undefined);
    return Promise.all(withSidecar.map((m) => this.startOne(m)));
  }

  /**
   * EA11: start a wasm sidecar in-process. Health is checked by calling the
   * module's exported health() function (must return 1).
   */
  private async startWasm(m: SidecarModule, tag: string): Promise<SidecarReport> {
    const name = m.manifest.name;
    const sidecar = m.manifest.sidecar as { wasm: string; port: number; health: string };
    this.log(`${tag} starting wasm: ${sidecar.wasm}`);
    const host = new WasmSidecarHost(sidecar.wasm, sidecar.port, this.log);
    try {
      await host.start(m.dir);
    } catch (e) {
      const reason = `wasm load failed: ${e instanceof Error ? e.message : String(e)}`;
      return this.fail(name, tag, sidecar.port, reason);
    }
    this.wasmHosts.set(name, host);
    // Poll health() until it returns 1 or we time out.
    const deadline = Date.now() + this.healthTimeoutMs;
    let healthy = false;
    while (Date.now() < deadline) {
      if (host.healthy()) {
        healthy = true;
        break;
      }
      await sleep(this.pollIntervalMs);
    }
    if (healthy) {
      this.statuses.set(name, "healthy");
      this.restartCounts.set(name, 0);
      this.log(`${tag} healthy (wasm)`);
      return { name, status: "healthy", port: sidecar.port };
    }
    this.wasmHosts.delete(name);
    await host.stop();
    return this.fail(name, tag, sidecar.port, `wasm health check timed out after ${this.healthTimeoutMs}ms`);
  }

  private async startOne(m: SidecarModule): Promise<SidecarReport> {
    const name = m.manifest.name;
    const sidecar = m.manifest.sidecar!;
    const tag = `[sidecar:${name}]`;
    this.stopping = false;
    this.modules.set(name, m);
    this.statuses.set(name, "starting");

    // EA11: wasm kind runs in-process via WasmSidecarHost (no OS process).
    if ("wasm" in sidecar) {
      return this.startWasm(m, tag);
    }

    // EA11: exec kind runs argv directly (no shell); command kind uses a shell.
    const isExec = "exec" in sidecar;
    const describe = isExec ? sidecar.exec.join(" ") : (sidecar as { command: string }).command;
    this.log(`${tag} starting: ${describe} (health http://localhost:${sidecar.port}${sidecar.health})`);

    let child: ChildProcess;
    try {
      if (isExec) {
        // exec kind: argv[0] is the binary, the rest are args. No shell —
        // no quoting issues, no shell injection. detached still groups the
        // process for tree-kill on stop().
        const [bin, ...args] = sidecar.exec;
        child = spawn(bin, args, {
          cwd: m.dir,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: true,
        });
      } else {
        // shell:true so manifest commands like `node ./brain-server.js` work
        // as written; cwd is the module dir so relative entries resolve.
        // detached:true puts the shell + its children in their own process
        // group, so stop() can tree-kill the real sidecar instead of only
        // the shell wrapper (which would orphan it).
        child = spawn(sidecar.command, {
          cwd: m.dir,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: true,
        });
      }
    } catch (e) {
      const reason = `failed to spawn: ${e instanceof Error ? e.message : String(e)}`;
      return this.fail(name, tag, sidecar.port, reason);
    }
    this.procs.set(name, child);
    child.stdout?.on("data", (d: Buffer) => this.log(`${tag} ${d.toString("utf8").trimEnd()}`));
    child.stderr?.on("data", (d: Buffer) => this.log(`${tag} stderr: ${d.toString("utf8").trimEnd()}`));

    let exitCode: number | null = null;
    let exited = false;
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
    });
    child.on("error", (err) => {
      this.log(`${tag} spawn error: ${err.message}`);
    });

    const deadline = Date.now() + this.healthTimeoutMs;
    let healthy = false;
    while (Date.now() < deadline && !exited) {
      if (await this.probe(sidecar.port, sidecar.health)) {
        healthy = true;
        break;
      }
      if (exited) break;
      await sleep(this.pollIntervalMs);
    }

    if (healthy) {
      this.statuses.set(name, "healthy");
      this.restartCounts.set(name, 0);
      this.log(`${tag} healthy`);
      // EA11: supervise the healthy sidecar — an unexpected exit restarts it.
      child.on("exit", (code, signal) => {
        if (this.stopping) return;
        // If stop() already reaped it, procs won't have it.
        if (!this.procs.has(name)) return;
        this.procs.delete(name);
        this.superviseRestart(name, tag, code, signal);
      });
      return { name, status: "healthy", port: sidecar.port };
    }
    const reason = exited
      ? `process exited (code ${exitCode}) before the health check passed`
      : `health check timed out after ${this.healthTimeoutMs}ms`;
    this.killTree(name, child);
    return this.fail(name, tag, sidecar.port, reason);
  }

  /**
   * EA11 restart supervision: a healthy sidecar that exits unexpectedly is
   * restarted with exponential backoff, up to maxRestarts consecutive
   * failures. After that the module is marked unhealthy and left down —
   * a crash loop must not spin forever.
   */
  private superviseRestart(name: string, tag: string, code: number | null, signal: string | null): void {
    const count = (this.restartCounts.get(name) ?? 0) + 1;
    this.restartCounts.set(name, count);
    if (count > this.maxRestarts) {
      this.statuses.set(name, "unhealthy");
      this.log(`${tag} DISABLED after ${this.maxRestarts} restarts: exited (code ${code}, signal ${signal})`);
      return;
    }
    const backoff = this.baseBackoffMs * 2 ** (count - 1);
    this.statuses.set(name, "starting");
    this.log(`${tag} exited (code ${code}, signal ${signal}) — restart ${count}/${this.maxRestarts} in ${backoff}ms`);
    const timer = setTimeout(() => {
      this.restartTimers.delete(name);
      if (this.stopping) return;
      const m = this.modules.get(name);
      if (!m) return;
      void this.startOne(m).then((report) => {
        // A failed restart counts toward the budget via the exit handler;
        // a report of "unhealthy" here means it never got healthy.
        if (report.status === "unhealthy") {
          this.log(`${tag} restart failed: ${report.reason}`);
        }
      });
    }, backoff);
    // Don't keep the host alive just for a restart timer.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.restartTimers.set(name, timer);
  }

  private fail(name: string, tag: string, port: number, reason: string): SidecarReport {
    this.statuses.set(name, "unhealthy");
    this.procs.delete(name);
    // Unhealthy = module disabled, loudly: the server still boots, but the
    // module's helper is out and the reason is on the record.
    this.log(`${tag} DISABLED: ${reason}`);
    return { name, status: "unhealthy", reason, port };
  }

  private probe(port: number, path: string): Promise<boolean> {
    return new Promise((resolve) => {
      const req = get({ host: "127.0.0.1", port, path, timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
    });
  }

  /**
   * Tree-kill a sidecar: the shell wrapper dies with the real process.
   * Killing just the wrapper would orphan the grandchild and leave its
   * stdio pipes open (which can pin the host's event loop).
   */
  private killTree(name: string, child: ChildProcess): void {
    this.procs.delete(name);
    killProcessTree(child.pid ?? -1, "SIGTERM");
  }

  /**
   * Graceful stop: SIGTERM to every sidecar tree, SIGKILL to stragglers
   * after killTimeoutMs. Resolves when all are gone.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const [, timer] of this.restartTimers) clearTimeout(timer);
    this.restartTimers.clear();
    // EA11: stop wasm sidecars in-process.
    for (const [name, host] of this.wasmHosts) {
      await host.stop();
      this.statuses.set(name, "stopped");
    }
    this.wasmHosts.clear();
    const entries = [...this.procs.entries()];
    this.procs.clear();
    await Promise.all(
      entries.map(
        ([name, child]) =>
          new Promise<void>((resolve) => {
            let settled = false;
            const done = (): void => {
              if (settled) return;
              settled = true;
              this.statuses.set(name, "stopped");
              resolve();
            };
            if (child.exitCode !== null || child.signalCode !== null) return done();
            const pid = child.pid ?? -1;
            const killer = setTimeout(() => {
              killProcessTree(pid, "SIGKILL");
              // If the exit event never fires, don't hang stop().
              setTimeout(done, 500).unref?.();
            }, this.killTimeoutMs);
            (killer as unknown as { unref?: () => void }).unref?.();
            child.once("exit", () => {
              clearTimeout(killer);
              done();
            });
            killProcessTree(pid, "SIGTERM");
          }),
      ),
    );
    this.log("[sidecar] all sidecars stopped");
  }

  /**
   * Synchronous hard kill for process-exit handlers, where nothing may be
   * awaited. Prefers stop() everywhere else.
   */
  killNow(): void {
    this.stopping = true;
    for (const [, timer] of this.restartTimers) clearTimeout(timer);
    this.restartTimers.clear();
    // EA11: wasm hosts are in-process; drop them (no async stop here).
    this.wasmHosts.clear();
    for (const [, child] of this.procs) {
      killProcessTree(child.pid ?? -1, "SIGKILL");
    }
    this.procs.clear();
  }
}
