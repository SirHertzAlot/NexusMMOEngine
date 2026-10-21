/**
 * The engine's skill contract: engine systems name specific content-defined
 * skill and technique ids, and silently degrade when the content renames or
 * drops one (body.ts "medicine" → skill 0; mastery-system "swimming" /
 * "athletics" → index -1; combat.ts "evading" / "parrying" / "blocking" →
 * skill 0; combat.ts "disarm" via discipline unlocks → never known).
 *
 * A content pack that declares skills must declare every id the engine needs:
 * boot fails loud naming the missing ids, like the rules cross-checker does
 * for body parts. A rules dir with no skills.json / disciplines.json at all
 * is skill-less mode — the contract is skipped and systems keep their
 * graceful fallbacks — so the engine still boots content-free.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Rules } from "@mmo-engine/rules";

/** Skill ids engine systems read directly. */
export const ENGINE_REQUIRED_SKILLS = [
  "athletics",
  "blocking",
  "evading",
  "medicine",
  "parrying",
  "swimming",
] as const;

/** Technique ids engine systems read directly (via discipline unlocks). */
export const ENGINE_REQUIRED_TECHNIQUES = ["disarm"] as const;

export class EngineSkillContractError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `engine skill contract: the rules declare skills but are missing ${missing.length === 1 ? "this id" : "these ids"} the engine needs: ${missing.join(", ")}`,
    );
    this.name = "EngineSkillContractError";
  }
}

/**
 * The engine-required ids missing from the rules. Empty when everything is
 * declared — and empty when the rules dir declares no skills/disciplines
 * files at all (skill-less mode).
 */
export function checkEngineSkillContract(rules: Rules, rulesDir: string): string[] {
  const missing: string[] = [];
  if (existsSync(join(rulesDir, "skills.json"))) {
    const have = new Set(rules.skills.skills.map((s) => s.id));
    for (const id of ENGINE_REQUIRED_SKILLS) {
      if (!have.has(id)) missing.push(`skill "${id}"`);
    }
  }
  if (existsSync(join(rulesDir, "disciplines.json"))) {
    const have = new Set(rules.disciplines.disciplines.flatMap((d) => d.unlocks));
    for (const id of ENGINE_REQUIRED_TECHNIQUES) {
      if (!have.has(id)) missing.push(`technique "${id}"`);
    }
  }
  return missing;
}

/** Fail loud when the content pack breaks the engine's skill contract. */
export function assertEngineSkillContract(rules: Rules, rulesDir: string): void {
  const missing = checkEngineSkillContract(rules, rulesDir);
  if (missing.length > 0) throw new EngineSkillContractError(missing);
}
