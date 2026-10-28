/**
 * SAB Logging Layer — runtime level control (docs/SAB-LOGGING-LAYER-SPEC.md §2.4)
 *
 * `loglevel` admin command: raising verbosity on any producer at runtime is
 * ONE atomic write into the ring header — no restart, no recompile. ERROR
 * is never maskable off (the producer checks `level < LogLevel.ERROR`), so
 * a threshold above ERROR is clamped to ERROR here and reported as such.
 *
 *   loglevel                         -> show every producer's threshold
 *   loglevel {producer, level}       -> set one producer
 *   loglevel {level}                 -> set all producers
 */
import { LogLevel, LogProducer } from "./log-codes.js";
import type { LogRingBuffer } from "./log-ring.js";

const LEVEL_BY_NAME: Record<string, number> = {
  trace: LogLevel.TRACE,
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  warning: LogLevel.WARN,
  error: LogLevel.ERROR,
};
const LEVEL_NAMES = ["trace", "debug", "info", "warn", "error"];

const PRODUCER_BY_NAME: Record<string, number> = {
  gateway: LogProducer.GATEWAY,
  sim: LogProducer.SIM,
  persist: LogProducer.PERSIST,
  world: LogProducer.WORLD,
  native: LogProducer.NATIVE,
  client: LogProducer.CLIENT,
  admin: LogProducer.ADMIN,
};
const PRODUCER_NAMES = Object.keys(PRODUCER_BY_NAME);

function parseLevel(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return Math.min(v, LogLevel.ERROR);
  if (typeof v === "string") {
    const n = LEVEL_BY_NAME[v.toLowerCase()];
    if (n !== undefined) return n;
  }
  return null;
}

function parseProducer(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < PRODUCER_NAMES.length) return v;
  if (typeof v === "string") {
    const n = PRODUCER_BY_NAME[v.toLowerCase()];
    if (n !== undefined) return n;
  }
  return null;
}

export interface LogLevelResult {
  ok: boolean;
  message: string;
}

export function runLogLevelCommand(ring: LogRingBuffer, args: unknown): LogLevelResult {
  const a = (args ?? {}) as { producer?: unknown; level?: unknown };
  const show = (): string =>
    PRODUCER_NAMES.map((n) => `${n}=${LEVEL_NAMES[Math.min(ring.getLevelMask(PRODUCER_BY_NAME[n]), LogLevel.ERROR)]}`).join(" ");

  if (a.level === undefined && a.producer === undefined) {
    return { ok: true, message: `${show()} dropped=${ring.droppedCount} (error is never masked)` };
  }
  if (a.level === undefined) {
    return { ok: false, message: "usage: loglevel {producer?, level} (levels: trace debug info warn error)" };
  }
  const level = parseLevel(a.level);
  if (level === null) {
    return { ok: false, message: `unknown level ${JSON.stringify(a.level)} (trace debug info warn error)` };
  }
  if (a.producer === undefined) {
    for (const n of PRODUCER_NAMES) ring.setLevelMask(PRODUCER_BY_NAME[n], level);
    return { ok: true, message: `all producers -> ${LEVEL_NAMES[level]}` };
  }
  const producer = parseProducer(a.producer);
  if (producer === null) {
    return { ok: false, message: `unknown producer ${JSON.stringify(a.producer)} (${PRODUCER_NAMES.join(" ")})` };
  }
  ring.setLevelMask(producer, level);
  return { ok: true, message: `${PRODUCER_NAMES[producer]} -> ${LEVEL_NAMES[level]}` };
}
