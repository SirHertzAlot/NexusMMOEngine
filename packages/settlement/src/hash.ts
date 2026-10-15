/** The content hash of a manifest: sha256 over its JSON with every object's keys sorted, so key order never matters. */

import { createHash } from "node:crypto";

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

export const contentHash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
