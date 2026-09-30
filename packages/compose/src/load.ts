/**
 * Node-only loaders: a game's ranks and catalog from JSON files. The rest
 * of the package runs anywhere (the client composes too); import this
 * through the package root, not "./browser".
 */

import { readFileSync } from "node:fs";
import { BUILTIN_CATALOG, catalogFromJson, type Catalog } from "./catalog.js";
import { DEFAULT_LADDER, ladderFromJson, type Ladder } from "./ranks.js";

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
}

/** A ladder from a file (see ladderFromJson); no file: the default ladder. */
export function loadLadder(file?: string): Ladder {
  return file ? ladderFromJson(readJson(file), file) : DEFAULT_LADDER;
}

/** Our catalog with a game's file merged over it (see catalogFromJson); no file: ours. */
export function loadCatalog(file?: string): Catalog {
  return file ? catalogFromJson(readJson(file), file) : BUILTIN_CATALOG;
}
