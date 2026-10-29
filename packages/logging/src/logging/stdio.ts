/**
 * SAB Logging Layer — stdio fallback seams (docs/SAB-LOGGING-LAYER-SPEC.md §2.1).
 *
 * A few library seams print to the console when no log ring is attached:
 * standalone CLI runs, tests, and processes that did not boot a log worker.
 * Centralizing the console calls here keeps the no-console guard meaningful
 * (the count of console calls outside this package can only be zero) while
 * preserving the old behavior for those callers.
 */

export function stdioLog(message: string): void {
  console.log(message);
}

export function stdioWarn(message: string): void {
  console.warn(message);
}

export function stdioError(message: string, err?: unknown): void {
  if (err === undefined) console.error(message);
  else console.error(message, err);
}
