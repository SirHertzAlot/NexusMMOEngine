/**
 * The game's rules at boot: content/rules (or MMO_RULES), validated in
 * full before the world starts. A bad rules file stops the server with
 * every problem named by file and field (see @mmo-engine/rules).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHooks, loadRules, type HookOverrides, type RuleHooks, type Rules } from "@mmo-engine/rules";

/** The repo's rules (this file runs from packages/engine-core/dist/src/rules). */
export const DEFAULT_RULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../content/rules");

export interface GameRules {
  rules: Rules;
  hooks: RuleHooks;
  dir: string;
  /** One line for the boot log. */
  summary: string;
}

/** Load and check the rules; throws RulesError listing every problem. */
export function loadGameRules(dir = DEFAULT_RULES_DIR, overrides: HookOverrides = {}): GameRules {
  const rules = loadRules(dir);
  const n = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
  const summary =
    `rules: ${n(rules.skills.skills.length, "skill")}, ${n(rules.disciplines.disciplines.length, "discipline")}, ` +
    `${n(rules.body.parts.length, "body part")}, ${n(rules.stats.attributes.length, "attribute")}, ` +
    `${n(rules.stats.stats.length, "stat")}, respawn after ${rules.death.respawn.delaySeconds} s (${dir})`;
  return { rules, hooks: createHooks(rules, overrides), dir, summary };
}
