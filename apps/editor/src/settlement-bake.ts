/**
 * The editor's Bake button (SG4b): runs `npm run settlement:bake` on the host, one bake at a time.
 * The bake's output is kept as a log tail the panel polls; Cancel stops the whole process group.
 * The CLI command still works on its own: this only starts the same command.
 */

import { spawn, type ChildProcess } from "node:child_process";

export type BakeState = "idle" | "running" | "done" | "failed" | "cancelled";

export interface BakeStatus {
  state: BakeState;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  /** The most recent output, newest last. */
  log: string;
}

export interface BakeInvocation {
  command: string;
  args: string[];
  shell: boolean;
}

/** Keep this much of the output (the panel shows the tail). */
export const BAKE_LOG_LIMIT = 64_000;

export class SettlementBake {
  private child: ChildProcess | null = null;
  private cancelRequested = false;
  private status: BakeStatus = { state: "idle", startedAt: null, finishedAt: null, exitCode: null, log: "" };

  constructor(
    private readonly invocation: () => BakeInvocation,
    private readonly cwd: string,
    private readonly now: () => number = Date.now,
  ) {}

  current(): BakeStatus {
    return { ...this.status };
  }

  /** Start a bake. Refused (409) while one is running. */
  start(): BakeStatus {
    if (this.child) throw Object.assign(new Error("a bake is already running"), { status: 409 });
    const inv = this.invocation();
    this.cancelRequested = false;
    this.status = { state: "running", startedAt: this.now(), finishedAt: null, exitCode: null, log: "" };
    const posix = process.platform !== "win32";
    const child = spawn(inv.command, inv.args, { cwd: this.cwd, stdio: ["ignore", "pipe", "pipe"], shell: inv.shell, detached: posix, windowsHide: true, env: process.env });
    this.child = child;
    const onData = (d: Buffer): void => {
      const text = this.status.log + d.toString("utf8");
      this.status = { ...this.status, log: text.length > BAKE_LOG_LIMIT ? text.slice(-BAKE_LOG_LIMIT) : text };
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      this.finish(null, `${err.message}\n`);
    });
    child.on("exit", (code) => {
      this.finish(code, "");
    });
    return this.current();
  }

  /** Stop the running bake (409 when none runs). The state turns to cancelled once the process has gone. */
  cancel(): BakeStatus {
    const child = this.child;
    if (!child) throw Object.assign(new Error("no bake is running"), { status: 409 });
    this.cancelRequested = true;
    if (child.pid !== undefined && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    } else {
      child.kill();
    }
    return this.current();
  }

  private finish(code: number | null, extra: string): void {
    if (!this.child) return;
    this.child = null;
    const text = this.status.log + extra;
    const state: BakeState = this.cancelRequested ? "cancelled" : code === 0 ? "done" : "failed";
    this.status = { ...this.status, state, finishedAt: this.now(), exitCode: code, log: text.length > BAKE_LOG_LIMIT ? text.slice(-BAKE_LOG_LIMIT) : text };
  }
}
