/**
 * Import for its effect: loads the repo's English table into the client's
 * `t()`, as main.tsx does with the inlined tables. A test of text that goes
 * through `t()` starts with `import "./i18n-setup.js";`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStrings, type StringTables } from "@mmo-engine/scene";
import { initI18n } from "../src/i18n.js";

// apps/client/dist/test → repo root content/strings
export const STRINGS_DIR = fileURLToPath(new URL("../../../../content/strings/", import.meta.url));

export function readTables(): StringTables {
  const tables: StringTables = {};
  for (const f of readdirSync(STRINGS_DIR).filter((n) => n.endsWith(".json"))) tables[f.slice(0, -5)] = loadStrings(JSON.parse(readFileSync(join(STRINGS_DIR, f), "utf8")));
  return tables;
}

initI18n(readTables());
