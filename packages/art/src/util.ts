/**
 * Internal helpers shared by the art pipeline modules.
 *
 * Not part of the public contract surface (index.ts does not re-export
 * this module); it exists so scan.ts and provider.ts stay DRY without
 * growing a public API Joey never asked for.
 */

/** Human-readable message for a caught value (load/scan failures are `unknown`). */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
