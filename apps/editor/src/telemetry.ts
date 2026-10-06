import type { AdminResult } from "@mmo-engine/protocol";

export const TELEMETRY_COUNTERS = [
  "kills",
  "deaths",
  "pickups",
  "drops",
  "damageDealt",
  "damageTaken",
] as const;

export type TelemetryCounter = (typeof TELEMETRY_COUNTERS)[number];

export interface PlayTelemetrySnapshot {
  bucketSeconds: number;
  buckets: number;
  series: Record<TelemetryCounter, number[]>;
  totals: Record<TelemetryCounter, number>;
  tick: { count: number; p50Ms: number; p99Ms: number; maxMs: number };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function parsePlayTelemetry(message: string): PlayTelemetrySnapshot {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    throw new Error("telemetry response is not JSON");
  }
  const root = object(value);
  const series = root && object(root.series);
  const totals = root && object(root.totals);
  const tick = root && object(root.tick);
  const bucketSeconds = root && number(root.bucketSeconds);
  const buckets = root && number(root.buckets);
  if (bucketSeconds === null || buckets === null || !Number.isInteger(bucketSeconds) || !Number.isInteger(buckets) || buckets < 1 || !series || !totals || !tick) {
    throw new Error("telemetry response has an invalid shape");
  }

  const parsedSeries = {} as Record<TelemetryCounter, number[]>;
  const parsedTotals = {} as Record<TelemetryCounter, number>;
  for (const name of TELEMETRY_COUNTERS) {
    const values = series[name];
    const total = number(totals[name]);
    if (!Array.isArray(values) || values.length !== buckets || values.some((item) => number(item) === null) || total === null) {
      throw new Error(`telemetry response has invalid ${name} data`);
    }
    parsedSeries[name] = values as number[];
    parsedTotals[name] = total;
  }

  const count = number(tick.count);
  const p50Ms = number(tick.p50Ms);
  const p99Ms = number(tick.p99Ms);
  const maxMs = number(tick.maxMs);
  if (count === null || p50Ms === null || p99Ms === null || maxMs === null || !Number.isInteger(count)) {
    throw new Error("telemetry response has invalid tick data");
  }
  return {
    bucketSeconds,
    buckets,
    series: parsedSeries,
    totals: parsedTotals,
    tick: { count, p50Ms, p99Ms, maxMs },
  };
}

export function telemetryFromAdmin(result: AdminResult): PlayTelemetrySnapshot {
  if (!result.ok) throw new Error(result.message);
  return parsePlayTelemetry(result.message);
}
