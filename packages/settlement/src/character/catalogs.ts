/**
 * Character catalogs loader, validator, and builtin sample pack.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CharacterCatalogsSchema,
  checkCharacterCatalogs,
  type CatalogIssue,
} from "./schemas.js";
import type { CharacterCatalogs } from "./types.js";
import { settlementPaths } from "../paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveDefaultCharacterPath(): string {
  try {
    const fromPaths = settlementPaths().character;
    if (existsSync(fromPaths)) return fromPaths;
  } catch {
    // fallback
  }
  const candidates = [
    resolve(__dirname, "../../../../../content/settlements/character.json"),
    resolve(__dirname, "../../../../content/settlements/character.json"),
    resolve(process.cwd(), "content/settlements/character.json"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

export const DEFAULT_CHARACTER_PATH = resolveDefaultCharacterPath();

/**
 * Loads character catalogs from a JSON file, validates schema and cross-references.
 * Throws a detailed error if validation fails.
 */
export function loadCharacterCatalogs(file: string = DEFAULT_CHARACTER_PATH): CharacterCatalogs {
  if (!existsSync(file)) {
    throw new Error(`Character catalogs file not found: ${file}`);
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const issues = checkCharacterCatalogs(raw);
  if (issues.length > 0) {
    const formatted = issues.map((i) => `  - [${i.path}]: ${i.message}`).join("\n");
    throw new Error(`Invalid character catalogs in ${file}:\n${formatted}`);
  }
  return raw as CharacterCatalogs;
}

let cachedDefault: CharacterCatalogs | null = null;

/**
 * Loads the default character catalogs (content/settlements/character.json or fallback).
 */
export function defaultCharacterCatalogs(file: string = DEFAULT_CHARACTER_PATH): CharacterCatalogs {
  if (cachedDefault && file === DEFAULT_CHARACTER_PATH) return cachedDefault;
  const cats = loadCharacterCatalogs(file);
  if (file === DEFAULT_CHARACTER_PATH) cachedDefault = cats;
  return cats;
}
