/**
 * Baking to a file: `<out>/<settlementId>.settlement.json`, the manifest as
 * pretty JSON. A reader recomputes the content hash and refuses a file that
 * was edited after it was baked (edit the request, not the output).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSettlement, MANIFEST_FORMAT, type GenerationResult, type SettlementManifest, type SettlementRequest } from "./generate.js";
import { contentHash } from "./hash.js";

export type BakeResult = (Extract<GenerationResult, { ok: true }> & { file: string }) | Extract<GenerationResult, { ok: false }>;

export function bakeSettlement(request: SettlementRequest, out: string): BakeResult {
  const r = generateSettlement(request);
  if (!r.ok) return r;
  mkdirSync(out, { recursive: true });
  const file = join(out, `${request.settlementId}.settlement.json`);
  writeFileSync(file, JSON.stringify(r.manifest, null, 2) + "\n");
  return { ...r, file };
}

export function readSettlement(file: string): SettlementManifest {
  const m = JSON.parse(readFileSync(file, "utf8")) as SettlementManifest;
  if (m.format !== MANIFEST_FORMAT) throw new Error(`not a ${MANIFEST_FORMAT} file (format: ${String(m.format)})`);
  const { hash, ...rest } = m;
  if (contentHash(rest) !== hash) throw new Error(`${file}: hash does not match its contents (edited after baking?)`);
  return m;
}
