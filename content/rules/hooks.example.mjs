/**
 * Example game hooks. Copy this file to `hooks.mjs` beside your rules and
 * the engine picks it up at boot; point `MMO_RULES_HOOKS` at it to keep it
 * somewhere else, or set `MMO_RULES_HOOKS=0` to run the engine's defaults.
 *
 * A hook is one decision the engine makes while the game runs. Replace
 * only what your game does differently: each replacement is handed the
 * engine's own version as `base`, so it can wrap it, ignore it, or use it
 * for part of the answer.
 *
 * The eight: computeDamage, resolveLanding, resolveDefence,
 * resolveTreatment, skillGain, onInjury, onDeath, onRespawn.
 * `packages/rules/src/hooks.ts` has what each is handed and must return.
 *
 * Hooks are the cheap path, not a fence. The engine is yours once it is
 * distributed to you: fork a system, replace it outright, or ignore this
 * file entirely. What hooks buy you is that your changes survive an
 * engine upgrade, because they sit beside your rules instead of inside
 * someone else's source file.
 */

export default {
  /** Head blows hurt more in this game than the engine's default. */
  computeDamage: (input, base) => {
    const hit = base(input);
    return input.part === "head" ? { ...hit, amount: hit.amount * 1.25 } : hit;
  },

  /** Learning is twice as fast under the halfway mark, as the engine has it after. */
  skillGain: (input, base) => base(input) * (input.skill < 0.5 ? 2 : 1),
};

/**
 * A function instead of an object is handed the loaded rules, so a game
 * can read its own numbers rather than hard-coding them here. It runs
 * again on every rules hot reload, so edits in the editor reach it with
 * no restart:
 *
 *   export default (rules) => ({
 *     onDeath: (input, base) => ({ ...base(input), respawnInSeconds: rules.death.respawn.delaySeconds * 2 }),
 *   });
 */
