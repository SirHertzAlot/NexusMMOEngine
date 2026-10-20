/**
 * Baking to a file: `<out>/<settlementId>.settlement.json`, the manifest as
 * pretty JSON. A reader recomputes the content hash and refuses a file that
 * was edited after it was baked (edit the request, not the output).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSettlement, MANIFEST_FORMAT, type GenerationResult, type SettlementManifest, type SettlementRequest } from "./generate.js";
import { contentHash } from "./hash.js";
import { BUILTIN_RULES } from "./rules.js";
import { settlementScene, type SceneOptions } from "./scene.js";

export type BakeResult = (Extract<GenerationResult, { ok: true }> & { file: string }) | Extract<GenerationResult, { ok: false }>;

/** `scene`: also write the scene the server's spawner loads (`MMO_SCENE=settlement-<id>`) into `dir`, the town centred on `origin`. */
export function bakeSettlement(request: SettlementRequest, out: string, opts: { scene?: SceneOptions & { dir: string } } = {}): BakeResult {
  const r = generateSettlement(request);
  if (!r.ok) return r;
  // The scene is checked before anything is written, so a failure leaves no half-baked pair.
  const scene = opts.scene ? settlementScene(r.manifest, request.rules ?? BUILTIN_RULES, opts.scene) : null;
  mkdirSync(out, { recursive: true });
  const file = join(out, `${request.settlementId}.settlement.json`);
  writeFileSync(file, JSON.stringify(r.manifest, null, 2) + "\n");
  if (scene && opts.scene) {
    mkdirSync(opts.scene.dir, { recursive: true });
    writeFileSync(join(opts.scene.dir, `${scene.name}.scene.json`), JSON.stringify(scene, null, 2) + "\n");
  }
  return { ...r, file };
}

export function readSettlement(file: string): SettlementManifest {
  const m = JSON.parse(readFileSync(file, "utf8")) as SettlementManifest;
  if (m.format !== MANIFEST_FORMAT) throw new Error(`not a ${MANIFEST_FORMAT} file (format: ${String(m.format)})`);
  const { hash, ...rest } = m;
  if (contentHash(rest) !== hash) throw new Error(`${file}: hash does not match its contents (edited after baking?)`);
  return m;
}
