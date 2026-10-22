/**
 * Host sidecar report shaping (persistence P5): the pure half of the
 * host sidecar. Everything here is testable without a process loop —
 * sampling takes an os-shaped source, shaping is a pure function,
 * and posting takes a fetch implementation.
 *
 * The sidecar reports capacity (never load-derived guesses): CPU
 * cores and RAM total/free from the OS. Co-located shard load is
 * included only when a caller supplies it — there is no load
 * protocol to invent here, so nothing fabricates one.
 */
import * as os from "node:os";

/** The os surface the sampler reads (node:os satisfies it; tests fake it). */
export interface HostOsSource {
  cpus(): unknown[];
  totalmem(): number;
  freemem(): number;
  hostname(): string;
}

/** The host's id: the explicit value when given, else the OS hostname. */
export function resolveHostId(
  explicit: string | undefined,
  source: HostOsSource = os,
): string {
  const trimmed = explicit?.trim();
  return trimmed ? trimmed : source.hostname();
}

export interface HostSample {
  cpuCores: number;
  ramTotalBytes: number;
  ramFreeBytes: number;
  /** Co-located shard load, only when trivially available to the caller. */
  shardLoad?: number;
}

/** Sample the host's capacity from an os-shaped source. */
export function sampleHost(source: HostOsSource = os): HostSample {
  return {
    cpuCores: Math.max(1, source.cpus().length),
    ramTotalBytes: source.totalmem(),
    ramFreeBytes: source.freemem(),
  };
}

/** The wire shape of a host report, minus the apiKey the poster adds. */
export interface HostReportInput {
  hostId: string;
  cpuCores: number;
  ramTotalBytes: number;
  ramFreeBytes: number;
  shardLoad?: number;
}

/**
 * Shape a sample into a report for `hostId` (defaulted via
 * resolveHostId). Pure: same sample + host, same report. ramFree is
 * clamped to ramTotal (a racing sampler must not produce a report
 * the world's edge validation would reject).
 */
export function buildHostReport(input: {
  hostId?: string;
  sample: HostSample;
  source?: HostOsSource;
}): HostReportInput {
  const { sample } = input;
  const report: HostReportInput = {
    hostId: resolveHostId(input.hostId, input.source ?? os),
    cpuCores: Math.max(1, Math.floor(sample.cpuCores)),
    ramTotalBytes: Math.max(0, Math.floor(sample.ramTotalBytes)),
    ramFreeBytes: Math.min(
      Math.max(0, Math.floor(sample.ramFreeBytes)),
      Math.max(0, Math.floor(sample.ramTotalBytes)),
    ),
  };
  if (sample.shardLoad !== undefined) report.shardLoad = sample.shardLoad;
  return report;
}

/**
 * Post one report to the world server's webrpc endpoint, using the
 * regions' bootstrap convention: the pre-shared WORLD_API_KEY rides
 * in the body (the sidecar holds no lease token). Never throws — a
 * dead world costs one report, and the next interval retries.
 * Returns whether the world accepted the report.
 */
export async function postHostReport(opts: {
  worldUrl: string;
  apiKey: string;
  report: HostReportInput;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<boolean> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.worldUrl.replace(/\/+$/, "");
  try {
    const res = await fetchFn(`${base}/rpc/World/ReportHostResources`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        input: { ...opts.report, apiKey: opts.apiKey },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
