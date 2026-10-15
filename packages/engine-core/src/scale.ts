/**
 * Global scale at boot: reads `content/scale.json` (`MMO_SCALE` names another
 * file) and hands the spawn paths a resolver, (category, asset) -> factor.
 * A bad file refuses to boot, naming every problem; a missing default file
 * means no scaling. See @mmo-engine/scene's scale.ts for the document.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_SCALE, resolveScale, validateScale, type ScaleCategory, type ScaleDoc } from "@mmo-engine/scene";

/** The factor for an object of `category`, optionally named `asset`. */
export type ScaleResolver = (category: ScaleCategory, asset?: string) => number;

/** The repo's content/scale.json (this file is dist/src/scale.js). */
export const DEFAULT_SCALE_FILE = fileURLToPath(new URL("../../../../content/scale.json", import.meta.url));

export const scaleResolver = (doc: ScaleDoc): ScaleResolver => (category, asset) => resolveScale(doc, category, asset);

/**
 * Load the scale document. `file` defaults to MMO_SCALE, else the repo's
 * file; only the default may be missing (a named file that isn't there is a typo).
 */
export function loadScale(file?: string, mustExist = true): ScaleResolver {
  const named = file ?? process.env.MMO_SCALE;
  const path = named || DEFAULT_SCALE_FILE;
  if (!existsSync(path)) {
    if (named && mustExist) throw new Error(`MMO_SCALE: no scale file ${path}`);
    return scaleResolver(DEFAULT_SCALE);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`scale file ${path}: not valid JSON: ${(e as Error).message}`);
  }
  const issues = validateScale(doc);
  if (issues.length > 0) throw new Error(`scale file ${path}: ${issues.map((i) => `${i.path || "(scale)"} ${i.message}`).join("; ")}`);
  return scaleResolver(doc as ScaleDoc);
}
