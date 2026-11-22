/**
 * Game hooks: the code seam a game plugs into without touching engine
 * source. `packages/rules` ships a default for each of the eight rule
 * hooks and `createHooks` already takes replacements; this is how a game
 * gets its replacements to the engine at boot.
 *
 * A game drops a `hooks.mjs` beside its rules (`content/rules/hooks.mjs`,
 * or whatever `MMO_RULES` points at), or names one with
 * `MMO_RULES_HOOKS=/path/to/hooks.mjs`. `MMO_RULES_HOOKS=0` ignores any
 * hooks file, which is how a run proves the engine's own defaults.
 *
 * The file default-exports either the overrides themselves:
 *
 *   export default {
 *     computeDamage: (input, base) => base(input) * (input.part === "head" ? 1.1 : 1),
 *   };
 *
 * or a factory, handed the loaded rules, so a game can read its own
 * tunables out of its rules files. A factory re-runs on every rules
 * reload, so edits to the rules reach it without a restart:
 *
 *   export default (rules) => ({
 *     skillGain: (input, base) => base(input) * rules.skills.max,
 *   });
 *
 * Each override is handed the engine's default as its second argument, so
 * it can wrap, replace or ignore it. Nothing here limits what a game may
 * do: a game that would rather fork the engine outright still can, and
 * the hooks exist to make the common changes cheap and upgrades painless.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { HOOK_NAMES, RulesError, type HookOverrides, type Rules } from "@mmo-engine/rules";

/** Overrides, or a factory handed the rules they will run against. */
export type HookOverridesInput = HookOverrides | ((rules: Rules) => HookOverrides);

/** File names looked for in the rules folder, in order. */
export const HOOKS_FILE_NAMES = ["hooks.mjs", "hooks.js"] as const;

/** Names a hooks file, or `0` to ignore one. */
export const HOOKS_ENV = "MMO_RULES_HOOKS";

export interface LoadedHooks {
  /** Applied to each load of the rules; the identity when there is no hooks file. */
  make: (rules: Rules) => HookOverrides;
  /** The file the overrides came from, or null when the engine's defaults stand alone. */
  file: string | null;
  /** A factory is re-run on every load, so its answer may change with the rules. */
  factory: boolean;
}

const NO_HOOKS: LoadedHooks = { make: () => ({}), file: null, factory: false };

/**
 * Which hooks file a run will use: the one `MMO_RULES_HOOKS` names, else
 * the first of `HOOKS_FILE_NAMES` present in the rules folder, else null.
 * `MMO_RULES_HOOKS=0` means null however the folder looks.
 *
 * Throws when the environment names a file that is not there: a game that
 * asked for its hooks should not boot quietly without them.
 */
export function resolveHooksFile(dir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env[HOOKS_ENV];
  if (named === "0") return null;
  if (named) {
    const file = path.isAbsolute(named) ? named : path.resolve(named);
    if (!fs.existsSync(file)) {
      throw new RulesError([{ file: named, path: HOOKS_ENV, message: "hooks file not found" }]);
    }
    return file;
  }
  for (const name of HOOKS_FILE_NAMES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Check a game's overrides before the engine runs on them: an object,
 * every key a hook the SDK knows, every value a function. A typo in a
 * hook name is the failure this catches — silently it would do nothing
 * at all, and only show up as the default behaviour in play.
 */
export function validateHookOverrides(value: unknown, where: string): HookOverrides {
  const issues: { file: string; path: string; message: string }[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RulesError([
      { file: where, path: "", message: `hooks must export an object of overrides (got ${describe(value)})` },
    ]);
  }
  const known = new Set<string>(HOOK_NAMES);
  for (const [name, fn] of Object.entries(value as Record<string, unknown>)) {
    if (!known.has(name)) {
      issues.push({ file: where, path: name, message: `not a hook (expected one of: ${HOOK_NAMES.join(", ")})` });
      continue;
    }
    if (typeof fn !== "function") {
      issues.push({ file: where, path: name, message: `must be a function (got ${describe(fn)})` });
    }
  }
  if (issues.length) throw new RulesError(issues);
  return value as HookOverrides;
}

/**
 * Load the game's hooks file, if it has one. Async because a hooks file
 * is a module; the result is sync from then on, so a rules reload applies
 * the same overrides with no further I/O.
 */
export async function loadHooks(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<LoadedHooks> {
  const file = resolveHooksFile(dir, env);
  if (!file) return NO_HOOKS;
  let mod: { default?: unknown; hooks?: unknown };
  try {
    mod = (await import(pathToFileURL(file).href)) as { default?: unknown; hooks?: unknown };
  } catch (err) {
    throw new RulesError([{ file, path: "", message: `hooks file could not be loaded: ${(err as Error).message}` }]);
  }
  const exported = mod.default ?? mod.hooks;
  if (exported === undefined) {
    throw new RulesError([{ file, path: "", message: "hooks file exports neither a default nor `hooks`" }]);
  }
  if (typeof exported === "function") {
    const factory = exported as (rules: Rules) => unknown;
    // Checked on every load, because a factory may answer differently as
    // the rules change under a hot reload.
    return { file, factory: true, make: (rules) => validateHookOverrides(factory(rules), file) };
  }
  const overrides = validateHookOverrides(exported, file);
  return { file, factory: false, make: () => overrides };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
