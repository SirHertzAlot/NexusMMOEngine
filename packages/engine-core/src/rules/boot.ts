/**
 * The game's rules at boot: content/rules (or MMO_RULES), validated in
 * full before the world starts. A bad rules file stops the server with
 * every problem named by file and field (see @mmo-engine/rules).
 *
 * A game's code-side changes come in beside its rules, as hooks (see
 * ./hook-overrides.ts). `openGameRules` finds them once and hands back a
 * loader that carries them into every load, boot and hot reload alike —
 * so the overrides cannot be dropped by one call site forgetting them.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHooks, loadRules, type HookOverrides, type RuleHooks, type Rules } from "@mmo-engine/rules";
import { loadHooks, validateHookOverrides, type HookOverridesInput } from "./hook-overrides.js";

/** The repo's rules (this file runs from packages/engine-core/dist/src/rules). */
export const DEFAULT_RULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../content/rules");

export interface GameRules {
  rules: Rules;
  hooks: RuleHooks;
  dir: string;
  /** The hooks this game replaced, in the order its hooks file names them. */
  overrides: readonly string[];
  /** One line for the boot log. */
  summary: string;
}

/**
 * Load and check the rules; throws RulesError listing every problem.
 *
 * `overrides` are the game's hook replacements, either the object itself
 * or a factory handed the loaded rules. Prefer `openGameRules`, which
 * finds a game's hooks file for you and keeps passing it on reload.
 */
export function loadGameRules(dir = DEFAULT_RULES_DIR, overrides: HookOverridesInput = {}): GameRules {
  const rules = loadRules(dir);
  const resolved: HookOverrides =
    typeof overrides === "function" ? validateHookOverrides(overrides(rules), `${dir} hooks`) : overrides;
  const names = Object.keys(resolved);
  const n = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
  const summary =
    `rules: ${n(rules.skills.skills.length, "skill")}, ${n(rules.disciplines.disciplines.length, "discipline")}, ` +
    `${n(rules.body.parts.length, "body part")}, ${n(rules.stats.attributes.length, "attribute")}, ` +
    `${n(rules.stats.stats.length, "stat")}, respawn after ${rules.death.respawn.delaySeconds} s (${dir})` +
    (names.length ? `, hooks: ${names.join(", ")}` : "");
  return { rules, hooks: createHooks(rules, resolved), dir, overrides: names, summary };
}

/**
 * A game's rules and its hooks, as one loader. Everything that loads the
 * rules after boot — the hot reloader above all — goes through `load`,
 * so a game's hooks survive a reload without each call site repeating
 * them.
 */
export interface GameRulesSource {
  readonly dir: string;
  /** The hooks file this game supplied, or null when it supplied none. */
  readonly hooksFile: string | null;
  /** Load (or reload) the rules with this game's hooks applied. */
  load(dir?: string): GameRules;
}

/**
 * Open the rules at `dir`, finding the game's hooks file first (see
 * ./hook-overrides.ts for where it looks). Async only because a hooks
 * file is a module: `load` is sync from then on.
 */
export async function openGameRules(
  dir: string = DEFAULT_RULES_DIR,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GameRulesSource> {
  const hooks = await loadHooks(dir, env);
  return {
    dir,
    hooksFile: hooks.file,
    load: (d = dir) => loadGameRules(d, hooks.make),
  };
}
