/**
 * EM1: enemy art from data. `content/enemies/models.local.json` maps a creature
 * kind to one catalog model id, or a list of them (picked round-robin, as the
 * wildlife table does). The file is gitignored: it names licensed models, so it
 * is baked on a host that has the art. A kind not in the file has no model, and
 * its stand-in block draws (the dev fallback).
 */

import fs from "node:fs";

export type EnemyModels = Record<string, string[]>;

/** Read the file's JSON: a kind maps to a model id or a list of them. Bad entries are reported and skipped, never fatal. */
export function parseEnemyModels(json: unknown, warn: (msg: string) => void = () => {}, isKnownKind: (kind: string) => boolean = () => true): EnemyModels {
  const out: EnemyModels = {};
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    warn("enemy models: the file must be an object mapping creature kinds to model ids");
    return out;
  }
  for (const [kind, value] of Object.entries(json as Record<string, unknown>)) {
    const ids = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
    if (!ids || ids.length === 0 || !ids.every((id) => typeof id === "string" && id.length > 0)) {
      warn(`enemy models: ${kind} needs a model id or a non-empty list of them`);
      continue;
    }
    if (!isKnownKind(kind)) warn(`enemy models: ${kind} is not a creature kind in the rules; its model is never used`);
    out[kind] = ids as string[];
  }
  return out;
}

/** Load the file (absent: no enemy models). A file that cannot be read or parsed is reported and ignored. */
export function loadEnemyModels(file: URL, warn: (msg: string) => void = () => {}, isKnownKind?: (kind: string) => boolean): EnemyModels {
  if (!fs.existsSync(file)) return {};
  try {
    return parseEnemyModels(JSON.parse(fs.readFileSync(file, "utf8")), warn, isKnownKind);
  } catch (err) {
    warn(`enemy models: ${file.pathname} unreadable (${(err as Error).message}); no enemy models`);
    return {};
  }
}

/** The `modelOf` for a creature kind: its next model id in turn, or undefined. */
export function enemyModelPicker(models: EnemyModels): (kind: string) => string | undefined {
  const picked = new Map<string, number>();
  return (kind) => {
    const ids = models[kind];
    if (!ids) return undefined;
    const n = picked.get(kind) ?? 0;
    picked.set(kind, n + 1);
    return ids[n % ids.length];
  };
}
