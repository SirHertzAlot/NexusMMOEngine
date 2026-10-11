/**
 * Stage cache: the last input hash per stage, in <cacheDir>/<stageId>.
 * A stage is skipped when its current input hash matches the cache.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function cachePath(cacheDir: string, stageId: string): string {
  return join(cacheDir, `${stageId}.sha256`);
}

export function readStageCache(cacheDir: string, stageId: string): string | null {
  try {
    return readFileSync(cachePath(cacheDir, stageId), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function writeStageCache(cacheDir: string, stageId: string, hash: string): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath(cacheDir, stageId), hash + "\n");
}

/** True when the stage must run: no cache, or the inputs changed. */
export function stageNeedsRun(cacheDir: string, stageId: string, currentHash: string): boolean {
  return readStageCache(cacheDir, stageId) !== currentHash;
}
