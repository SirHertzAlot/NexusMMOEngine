/**
 * Host sidecar entry: `npm run sidecar --workspace=@mmo-engine/world-server`.
 *
 * A small separate process per host (persistence P5): on an interval
 * it samples the host's capacity and posts a resource report to the
 * world server, whose assignment policy sizes chunk ranges by it.
 * It never simulates, never touches a tick loop, and holds no state
 * beyond its timer. The report logic lives in sidecar-report.ts;
 * this file is only the process loop around it.
 *
 * Environment:
 *   WORLD_URL               world server base URL (default http://127.0.0.1:7780)
 *   WORLD_API_KEY           bootstrap key matching the world's (required)
 *   HOST_ID                 this host's id (default: the OS hostname)
 *   HOST_REPORT_INTERVAL_MS report interval (default 5000)
 */
import { pathToFileURL } from "node:url";
import {
  buildHostReport,
  postHostReport,
  resolveHostId,
  sampleHost,
} from "./sidecar-report.js";

async function main(): Promise<void> {
  const worldUrl = process.env.WORLD_URL ?? "http://127.0.0.1:7780";
  const apiKey = process.env.WORLD_API_KEY;
  if (!apiKey) {
    console.error(
      "[sidecar] WORLD_API_KEY unset: the world would reject every report; exiting",
    );
    process.exit(1);
  }
  const hostId = resolveHostId(process.env.HOST_ID);
  const intervalMs = Math.max(
    250,
    Number(process.env.HOST_REPORT_INTERVAL_MS ?? 5000) || 5000,
  );

  const reportOnce = async (): Promise<void> => {
    const report = buildHostReport({ hostId, sample: sampleHost() });
    const ok = await postHostReport({ worldUrl, apiKey, report });
    if (!ok) {
      console.warn(
        `[sidecar] host report for ${hostId} not accepted by ${worldUrl}; retrying next interval`,
      );
    }
  };

  await reportOnce();
  // NOT unref'd: this timer is the process's whole reason to exist —
  // with no listener and no other handles, an unref'd timer would let
  // the loop empty and the sidecar would exit after its first report.
  const timer = setInterval(() => void reportOnce(), intervalMs);
  console.log(
    `[sidecar] reporting host ${hostId} to ${worldUrl} every ${intervalMs}ms`,
  );

  const shutdown = (sig: string): void => {
    console.log(`[sidecar] ${sig}: shutting down`);
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    console.error("[sidecar] fatal", err);
    process.exit(1);
  });
}
