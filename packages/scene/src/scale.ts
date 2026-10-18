/**
 * The global scale document (`content/scale.json`): how big the world's
 * objects are, in one place. A factor for the whole world, one per kind of
 * object, and per-asset corrections (an exact asset id, or a prefix ending in
 * `*`), all multiplied. Art arrives at whatever size its author chose; this
 * is the dial that makes buildings, trees and rocks the right size for a
 * 1.8 m character, without re-baking anything. The server applies it where
 * baked objects spawn (Transform scale and collision both), so what the client
 * draws and what blocks you always agree.
 */

import type { SceneIssue } from "./index.js";

export const SCALE_VERSION = 1;
export const SCALE_CATEGORIES = ["building", "tree", "rock", "plant", "prop"] as const;
export type ScaleCategory = (typeof SCALE_CATEGORIES)[number];

/** The range any one factor may take: outside it is a typo, not a design. */
export const SCALE_MIN = 0.05;
export const SCALE_MAX = 20;

export interface ScaleDoc {
  version: typeof SCALE_VERSION;
  /** Every object. */
  global: number;
  /** Per kind of object; a kind with no entry counts as 1. */
  categories: Partial<Record<ScaleCategory, number>>;
  /** Per asset id, or an id prefix ending in `*` (the longest match wins; an exact id beats a prefix). */
  assets: Record<string, number>;
}

export const DEFAULT_SCALE: ScaleDoc = { version: SCALE_VERSION, global: 1, categories: {}, assets: {} };

/** The factor for an object of `category`, optionally named `asset`: global x category x the asset's own. */
export function resolveScale(doc: ScaleDoc, category: ScaleCategory, asset?: string): number {
  let own = 1;
  if (asset !== undefined) {
    const exact = doc.assets[asset];
    if (exact !== undefined) own = exact;
    else {
      let best = -1;
      for (const [key, factor] of Object.entries(doc.assets)) {
        if (key.endsWith("*") && asset.startsWith(key.slice(0, -1)) && key.length > best) {
          best = key.length;
          own = factor;
        }
      }
    }
  }
  return doc.global * (doc.categories[category] ?? 1) * own;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const factorProblem = (v: unknown): string | null =>
  typeof v !== "number" || !Number.isFinite(v) ? "must be a number" : v < SCALE_MIN || v > SCALE_MAX ? `must be between ${SCALE_MIN} and ${SCALE_MAX}` : null;

/** Every problem in `doc`, each with the path of the offending value. */
export function validateScale(doc: unknown): SceneIssue[] {
  const out: SceneIssue[] = [];
  const bad = (path: string, message: string): void => void out.push({ path, message });
  if (!isObj(doc)) return [{ path: "", message: "a scale document must be a JSON object" }];
  if (doc.version !== SCALE_VERSION) bad("version", `must be ${SCALE_VERSION}`);
  const g = factorProblem(doc.global);
  if (g) bad("global", g);
  if (!isObj(doc.categories)) bad("categories", "must be an object");
  else {
    for (const [k, v] of Object.entries(doc.categories)) {
      if (!(SCALE_CATEGORIES as readonly string[]).includes(k)) bad(`categories.${k}`, `unknown category (have ${SCALE_CATEGORIES.join(", ")})`);
      else if (factorProblem(v)) bad(`categories.${k}`, factorProblem(v)!);
    }
  }
  if (!isObj(doc.assets)) bad("assets", "must be an object");
  else for (const [k, v] of Object.entries(doc.assets)) if (factorProblem(v)) bad(`assets.${k}`, factorProblem(v)!);
  return out;
}
