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
import { writeDump, type ParkTrigger, type SidecarDump, type SidecarExit, type SidecarOutputLine, type SidecarProbe } from "./sidecar-dump.js";

export type SidecarStatus = "starting" | "healthy" | "unhealthy" | "parked" | "stopped";

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
    version?: string;
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
  /** Present when the sidecar was parked or gave up: where its dump was written. */
  dumpFile?: string;
}

/** What the manager remembers about one sidecar, for its dump. */
interface SidecarRecord {
  startedAt: number | null;
  lastHealthyAt: number | null;
  instances: number;
  exits: SidecarExit[];
  output: SidecarOutputLine[];
  probes: SidecarProbe[];
  probeCount: number;
  probeFailures: number;
  pid: number | null;
  spawnError?: string;
  lastReason: string;
  lastDump?: SidecarDump;
  lastDumpFile?: string;
}

const OUTPUT_LINES = 200;
const PROBE_HISTORY = 20;

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
   * delay, doubled each time (default 1_000). A restart only stops counting
   * once the sidecar has stayed up for `stableMs` (default 30_000), so a
   * sidecar that turns healthy and crashes again still runs out of restarts.
   */
  restartPolicy?: { maxRestarts?: number; baseBackoffMs?: number; stableMs?: number };
  /** Where parked and given-up sidecars write their dump (JSON). Unset: dumps are kept in memory only (dumpOf). */
  dumpDir?: string;
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
  private readonly stableMs: number;
  private readonly dumpDir: string | undefined;
  private readonly records = new Map<string, SidecarRecord>();
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
    this.stableMs = opts.restartPolicy?.stableMs ?? 30_000;
    this.dumpDir = opts.dumpDir;
  }

  private record(name: string): SidecarRecord {
    let r = this.records.get(name);
    if (!r) {
      r = { startedAt: null, lastHealthyAt: null, instances: 0, exits: [], output: [], probes: [], probeCount: 0, probeFailures: 0, pid: null, lastReason: "" };
      this.records.set(name, r);
    }
    return r;
  }

  private note(name: string, stream: "stdout" | "stderr", chunk: Buffer): void {
    const out = this.record(name).output;
    for (const text of chunk.toString("utf8").split("\n")) {
      if (text.trim() === "") continue;
      out.push({ at: new Date().toISOString(), stream, text });
    }
    if (out.length > OUTPUT_LINES) out.splice(0, out.length - OUTPUT_LINES);
  }

  /** Every known sidecar and its status, by module name. */
  list(): Array<{ name: string; status: SidecarStatus; dump: boolean }> {
    return [...this.statuses.entries()].map(([name, status]) => ({ name, status, dump: this.records.get(name)?.lastDump !== undefined }));
  }

  /** The last dump a sidecar left (parked or given up), if any. */
  dumpOf(name: string): SidecarDump | undefined {
    return this.records.get(name)?.lastDump;
  }

  /**
   * Park a sidecar: stop it for good (no restarts) and leave a dump of the
   * error and its 5W1H context. The module's entry stays registered, so
   * replace() can start a fresh instance later.
   */
  async park(name: string, reason = "parked by hand", trigger: ParkTrigger = "manual"): Promise<SidecarReport> {
    const m = this.modules.get(name);
    if (!m) return { name, status: "stopped", reason: "unknown sidecar" };
    const timer = this.restartTimers.get(name);
    if (timer) clearTimeout(timer);
    this.restartTimers.delete(name);
    const child = this.procs.get(name);
    this.procs.delete(name); // so its exit isn't supervised as a crash
    const host = this.wasmHosts.get(name);
    this.wasmHosts.delete(name);
    if (host) await host.stop();
    if (child) await this.reap(child);
    this.statuses.set(name, "parked");
    this.log(`[sidecar:${name}] PARKED: ${reason}`);
    const dumpFile = this.dump(name, trigger, reason);
    const sc = m.manifest.sidecar!;
    return { name, status: "parked", reason, port: sc.port, dumpFile };
  }

  /**
   * Start a sidecar from a clean slate: park whatever is running (the dump is
   * kept), forget its restart history, and start a new instance of the same
   * module.
   */
  async replace(name: string): Promise<SidecarReport> {
    const m = this.modules.get(name);
    if (!m) return { name, status: "stopped", reason: "unknown sidecar" };
    if (this.procs.has(name) || this.wasmHosts.has(name)) await this.park(name, "replaced by a fresh instance", "replace");
    this.restartCounts.set(name, 0);
    const r = this.record(name);
    r.exits = [];
    r.output = [];
    r.probes = [];
    r.spawnError = undefined;
    return this.startOne(m);
  }

  /** Terminate one child tree and wait for it to go. */
  private reap(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const pid = child.pid ?? -1;
      const killer = setTimeout(() => {
        killProcessTree(pid, "SIGKILL");
        setTimeout(resolve, 500).unref?.();
      }, this.killTimeoutMs);
      (killer as unknown as { unref?: () => void }).unref?.();
      child.once("exit", () => {
        clearTimeout(killer);
        resolve();
      });
      killProcessTree(pid, "SIGTERM");
    });
  }

  /** Build (and, with dumpDir, write) the dump for a sidecar. Returns the file path if one was written. */
  private dump(name: string, trigger: ParkTrigger, reason: string): string | undefined {
    const m = this.modules.get(name);
    if (!m) return undefined;
    const sc = m.manifest.sidecar!;
    const r = this.record(name);
    const last = r.exits[r.exits.length - 1];
    const kind = "wasm" in sc ? "wasm" : "exec" in sc ? "exec" : "command";
    const now = Date.now();
    const d: SidecarDump = {
      schema: 1,
      who: { module: name, version: m.manifest.version, kind, pid: r.pid, managerPid: process.pid },
      what: {
        trigger,
        reason,
        status: this.statuses.get(name) ?? "unknown",
        error: {
          exitCode: last?.code ?? null,
          signal: last?.signal ?? null,
          spawnError: r.spawnError,
          stderrTail: r.output.filter((l) => l.stream === "stderr").slice(-30).map((l) => l.text),
        },
      },
      when: {
        parkedAt: new Date(now).toISOString(),
        startedAt: r.startedAt === null ? null : new Date(r.startedAt).toISOString(),
        lastHealthyAt: r.lastHealthyAt === null ? null : new Date(r.lastHealthyAt).toISOString(),
        uptimeMs: r.startedAt === null ? null : now - r.startedAt,
        exits: r.exits,
      },
      where: {
        moduleDir: m.dir,
        port: sc.port,
        healthUrl: `http://127.0.0.1:${sc.port}${sc.health}`,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        envKeys: Object.keys(process.env).sort(),
      },
      why: {
        trigger,
        restartCount: this.restartCounts.get(name) ?? 0,
        restartPolicy: { maxRestarts: this.maxRestarts, baseBackoffMs: this.baseBackoffMs, stableMs: this.stableMs },
      },
      how: {
        command: "wasm" in sc ? `wasm:${sc.wasm}` : "exec" in sc ? sc.exec.join(" ") : sc.command,
        recentProbes: r.probes,
      },
      output: r.output,
      telemetry: { instances: r.instances, unexpectedExits: r.exits.length, probes: r.probeCount, probeFailures: r.probeFailures },
    };
    r.lastDump = d;
    r.lastDumpFile = undefined;
    if (this.dumpDir) {
      try {
        r.lastDumpFile = writeDump(this.dumpDir, d);
        this.log(`[sidecar:${name}] dump written: ${r.lastDumpFile}`);
      } catch (e) {
        this.log(`[sidecar:${name}] could not write the dump: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return r.lastDumpFile;
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
    const rec = this.record(name);
    rec.instances += 1;
    rec.startedAt = Date.now();
    rec.pid = null;

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
      rec.spawnError = reason;
      return this.fail(name, tag, sidecar.port, reason, "start-failed");
    }
    this.procs.set(name, child);
    rec.pid = child.pid ?? null;
    child.stdout?.on("data", (d: Buffer) => {
      this.note(name, "stdout", d);
      this.log(`${tag} ${d.toString("utf8").trimEnd()}`);
    });
    child.stderr?.on("data", (d: Buffer) => {
      this.note(name, "stderr", d);
      this.log(`${tag} stderr: ${d.toString("utf8").trimEnd()}`);
    });

    let exitCode: number | null = null;
    let exited = false;
    child.on("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      // A sidecar stopped on purpose (parked, replaced, shut down) is no crash.
      if (this.procs.get(name) === child) {
        rec.exits.push({ at: new Date().toISOString(), code, signal, uptimeMs: Date.now() - (rec.startedAt ?? Date.now()) });
      }
    });
    child.on("error", (err) => {
      rec.spawnError = err.message;
      this.log(`${tag} spawn error: ${err.message}`);
    });

    const deadline = Date.now() + this.healthTimeoutMs;
    let healthy = false;
    while (Date.now() < deadline && !exited) {
      const ok = await this.probe(sidecar.port, sidecar.health);
      rec.probeCount += 1;
      if (!ok) rec.probeFailures += 1;
      rec.probes.push({ at: new Date().toISOString(), ok });
      if (rec.probes.length > PROBE_HISTORY) rec.probes.shift();
      if (ok) {
        healthy = true;
        break;
      }
      if (exited) break;
      await sleep(this.pollIntervalMs);
    }

    if (healthy) {
      this.statuses.set(name, "healthy");
      rec.lastHealthyAt = Date.now();
      this.log(`${tag} healthy`);
      // Only a sidecar that stays up forgives its earlier crashes: resetting the count on
      // every healthy report would let a crash loop that briefly turns healthy restart forever.
      const stable = setTimeout(() => this.restartCounts.set(name, 0), this.stableMs);
      (stable as unknown as { unref?: () => void }).unref?.();
      // EA11: supervise the healthy sidecar — an unexpected exit restarts it.
      child.on("exit", (code, signal) => {
        clearTimeout(stable);
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
    return this.fail(name, tag, sidecar.port, reason, "start-failed");
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
      this.dump(name, "crash-loop", `exited ${count} times in a row (code ${code}, signal ${signal}); the restart limit is ${this.maxRestarts}`);
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

  private fail(name: string, tag: string, port: number, reason: string, trigger: ParkTrigger = "start-failed"): SidecarReport {
    this.statuses.set(name, "unhealthy");
    this.procs.delete(name);
    const dumpFile = this.dump(name, trigger, reason);
    // Unhealthy = module disabled, loudly: the server still boots, but the
    // module's helper is out and the reason is on the record.
    this.log(`${tag} DISABLED: ${reason}`);
    return { name, status: "unhealthy", reason, port, dumpFile };
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
