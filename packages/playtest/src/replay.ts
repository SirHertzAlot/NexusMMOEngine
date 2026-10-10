/**
 * Failure replays: a scenario + the failure that stopped it, sealed with a
 * hash. Re-running the replay's scenario with its seed reproduces the
 * failure tick for tick (bots hash their randomness from the seed).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadScenario, type Scenario } from "./scenario.js";

export interface ReplayFailure {
  tick: number;
  reason: string;
}

/** The bots' centroid after a tick: what a re-run is compared against. */
export interface TracePoint {
  tick: number;
  x: number;
  z: number;
}

export interface Replay {
  scenario: Scenario;
  failure: ReplayFailure;
  savedAt: string;
  /** The original run's trace; absent in replays saved before traces existed. */
  trace?: TracePoint[];
}

interface ReplayFile extends Replay {
  seal: string;
}

function sealOf(replay: Replay): string {
  return createHash("sha256")
    .update(JSON.stringify({ scenario: replay.scenario, failure: replay.failure, ...(replay.trace ? { trace: replay.trace } : {}) }))
    .digest("hex");
}

/** Save a replay; returns the file path. */
export function saveReplay(dir: string, scenario: Scenario, failure: ReplayFailure, trace?: TracePoint[]): string {
  const replay: Replay = { scenario, failure, savedAt: new Date().toISOString(), ...(trace ? { trace } : {}) };
  const file: ReplayFile = { ...replay, seal: sealOf(replay) };
  mkdirSync(dir, { recursive: true });
  const name = `replay-${scenario.name}-${Date.now()}.json`;
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(file, null, 2) + "\n");
  return p;
}

/** Load and verify a replay (throws on tampering). */
export function loadReplay(path: string): Replay {
  let file: ReplayFile;
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as ReplayFile;
  } catch {
    throw new Error(`replay ${path}: invalid replay file`);
  }
  const replay: Replay = { scenario: loadScenario(file.scenario), failure: file.failure, savedAt: file.savedAt, ...(file.trace ? { trace: file.trace } : {}) };
  const expected = sealOf(replay);
  const actual = Buffer.from(file.seal ?? "", "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, Buffer.from(expected, "utf8"))) {
    throw new Error(`replay ${path}: seal mismatch (tampered or corrupt)`);
  }
  return replay;
}

/** First tick at which two traces differ; null when they match. A shorter trace diverges where it stops. */
export function firstDivergence(a: TracePoint[], b: TracePoint[]): number | null {
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i];
    if (!q) return p.tick;
    if (p.tick !== q.tick || p.x !== q.x || p.z !== q.z) return p.tick;
  }
  return b.length > a.length ? b[a.length]!.tick : null;
}
