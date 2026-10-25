/**
 * The telemetry and debugging dump a sidecar leaves when it is parked (or
 * gives up): everything someone needs to work out what went wrong without
 * reproducing it, laid out as the 5W1H (who, what, when, where, why, how).
 * Environment variables are listed by name only, never by value.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ParkTrigger = "manual" | "crash-loop" | "start-failed" | "replace";

export interface SidecarProbe {
  at: string;
  ok: boolean;
}

export interface SidecarExit {
  at: string;
  code: number | null;
  signal: string | null;
  /** How long that instance had been running, ms. */
  uptimeMs: number;
}

export interface SidecarOutputLine {
  at: string;
  stream: "stdout" | "stderr";
  text: string;
}

export interface SidecarDump {
  schema: 1;
  who: { module: string; version?: string; kind: "command" | "exec" | "wasm"; pid: number | null; managerPid: number };
  what: {
    trigger: ParkTrigger;
    reason: string;
    status: string;
    error: { exitCode: number | null; signal: string | null; spawnError?: string; stderrTail: string[] };
  };
  when: { parkedAt: string; startedAt: string | null; lastHealthyAt: string | null; uptimeMs: number | null; exits: SidecarExit[] };
  where: {
    moduleDir: string;
    port: number;
    healthUrl: string;
    platform: string;
    arch: string;
    node: string;
    envKeys: string[];
  };
  why: { trigger: ParkTrigger; restartCount: number; restartPolicy: { maxRestarts: number; baseBackoffMs: number; stableMs: number } };
  how: { command: string; recentProbes: SidecarProbe[] };
  output: SidecarOutputLine[];
  telemetry: { instances: number; unexpectedExits: number; probeFailures: number; probes: number };
}

/** Write the dump as JSON under `dir`; returns the file path. */
export function writeDump(dir: string, dump: SidecarDump): string {
  mkdirSync(dir, { recursive: true });
  const stamp = dump.when.parkedAt.replace(/[:.]/g, "-");
  const file = join(dir, `${dump.who.module}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(dump, null, 2) + "\n", "utf8");
  return file;
}
