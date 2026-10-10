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
    sidecar?: { command: string; port: number; health: string };
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
  private readonly procs = new Map<string, ChildProcess>();
  private readonly statuses = new Map<string, SidecarStatus>();

  constructor(opts: SidecarManagerOptions = {}) {
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 15_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.killTimeoutMs = opts.killTimeoutMs ?? 5_000;
    this.log = opts.log ?? (() => {});
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

  private async startOne(m: SidecarModule): Promise<SidecarReport> {
    const name = m.manifest.name;
    const sidecar = m.manifest.sidecar!;
    const tag = `[sidecar:${name}]`;
    this.statuses.set(name, "starting");
    this.log(`${tag} starting: ${sidecar.command} (health http://localhost:${sidecar.port}${sidecar.health})`);

    let child: ChildProcess;
    try {
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
      this.log(`${tag} healthy`);
      return { name, status: "healthy", port: sidecar.port };
    }
    const reason = exited
      ? `process exited (code ${exitCode}) before the health check passed`
      : `health check timed out after ${this.healthTimeoutMs}ms`;
    this.killTree(name, child);
    return this.fail(name, tag, sidecar.port, reason);
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
    for (const [, child] of this.procs) {
      killProcessTree(child.pid ?? -1, "SIGKILL");
    }
    this.procs.clear();
  }
}
