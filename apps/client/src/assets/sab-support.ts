/**
 * Capability probe for the client SAB asset pipeline (SAB Phase 6).
 *
 * SharedArrayBuffer is only available in cross-origin isolated pages, which
 * requires the deployment to serve COOP/COEP headers (see
 * docs/CLIENT-SAB-ASSET-PIPELINE.md). When any leg is missing the pipeline
 * falls back to main-thread decode of the same bytes — same geometry out,
 * just decoded on the main thread. The fallback is the correctness floor:
 * nothing in the client may require SAB to load an asset.
 *
 * `env` exists so tests can probe each combination without a browser.
 */

export interface SabEnvironment {
  SharedArrayBuffer?: unknown;
  Worker?: unknown;
  /** `self.crossOriginIsolated` in a browser; undefined in Node / non-isolated pages. */
  crossOriginIsolated?: boolean;
}

export interface SabSupport {
  /** SharedArrayBuffer constructor present. */
  sharedArrayBuffer: boolean;
  /** Page is cross-origin isolated (COOP/COEP served) — the SAB gate. */
  crossOriginIsolated: boolean;
  /** Web Workers available. */
  worker: boolean;
  /** All three legs present: the SAB worker path can run. */
  usable: boolean;
  /** Human-readable reason when not usable (for dev-overlay / logs). */
  reason: string;
}

function defaultEnv(): SabEnvironment {
  const g = globalThis as unknown as SabEnvironment & Record<string, unknown>;
  return {
    SharedArrayBuffer: g.SharedArrayBuffer,
    Worker: g.Worker,
    crossOriginIsolated: g.crossOriginIsolated as boolean | undefined,
  };
}

export function probeSabSupport(env: SabEnvironment = defaultEnv()): SabSupport {
  const sharedArrayBuffer = typeof env.SharedArrayBuffer !== "undefined";
  const crossOriginIsolated = env.crossOriginIsolated === true;
  const worker = typeof env.Worker !== "undefined";
  const usable = sharedArrayBuffer && crossOriginIsolated && worker;
  const reason = usable
    ? "SAB worker decode available"
    : !sharedArrayBuffer
      ? "SharedArrayBuffer unavailable — serve the page cross-origin isolated (COOP/COEP headers)"
      : !crossOriginIsolated
        ? "page is not cross-origin isolated — serve COOP/COEP headers (see docs/CLIENT-SAB-ASSET-PIPELINE.md)"
        : "Web Workers unavailable";
  return { sharedArrayBuffer, crossOriginIsolated, worker, usable, reason };
}
