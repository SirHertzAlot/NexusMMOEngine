/**
 * The combat moves at boot: content/combat/moves.json (or MMO_COMBAT)
 * replaces the engine's built-in moves before the world starts, so the
 * editor's timeline edits (hit frame, chain window, advance) change the
 * fight. A missing file keeps the built-in moves; a bad one throws with
 * every problem by path, like the rules.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setCombatMoves, validateCombatMoves } from "@mmo-engine/protocol";

function resolveCombatFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate4 = path.resolve(here, "../../../../content/combat/moves.json");
  if (fs.existsSync(candidate4)) return candidate4;
  const candidate3 = path.resolve(here, "../../../content/combat/moves.json");
  if (fs.existsSync(candidate3)) return candidate3;
  return path.resolve(process.cwd(), "content/combat/moves.json");
}
export const DEFAULT_COMBAT_FILE = resolveCombatFile();

/** Load the moves; returns a boot-log line (null: no file, built-in moves in force). */
export function loadCombatContent(file = DEFAULT_COMBAT_FILE): string | null {
  if (!fs.existsSync(file)) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`combat moves: ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const issues = validateCombatMoves(doc);
  if (issues.length > 0) throw new Error(`invalid combat moves (${file}):\n${issues.map((i) => `  ${i.path}: ${i.message}`).join("\n")}`);
  setCombatMoves(doc);
  return `combat: ${(doc as { moves: unknown[] }).moves.length} moves (${file})`;
}
