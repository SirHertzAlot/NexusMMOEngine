/**
 * The wildlife table as creature rules: every species of `content/wildlife/wildlife.json`
 * becomes a kind in the creatures table the CreatureSystem runs, so each number (health,
 * damage against a goblin's, notice radius, warning seconds, group size) lives in the one
 * table and nowhere else. Pure and generic: no species is named here. The natural weapon
 * (bite, claw, tusk, horn, crush, tailslam: item bases in items.json) comes from
 * `content/wildlife/natural.json` by species, else by role.
 *
 * Derived, not tabled, numbers (a tuning knob each):
 *  - leash: a fifth of the territory, held within 25 to 150 m (a wolf's 1500 m range is where it
 *    lives, not how far it chases);
 *  - run speed: 0.75 of a player's walk plus 0.05 per danger tier, at most 1; prey run `fleeSpeed` faster;
 *  - blow rate: 1.2 s plus 0.2 s per tier (bigger things swing slower);
 *  - respawn: 300 s; animals drop nothing (hides and meat are the crafting agent's).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CreaturesRules } from "@mmo-engine/rules";
import type { WildlifeTable } from "./wildlife-table.js";

export const DEFAULT_NATURAL_WEAPONS = fileURLToPath(new URL("../../../content/wildlife/natural.json", import.meta.url));

export interface NaturalWeapons {
  byRole: Record<string, string>;
  species: Record<string, string>;
}

export function loadNaturalWeapons(file: string = DEFAULT_NATURAL_WEAPONS): NaturalWeapons {
  const j = JSON.parse(readFileSync(file, "utf8")) as Partial<NaturalWeapons>;
  return { byRole: j.byRole ?? {}, species: j.species ?? {} };
}

const title = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, " ");
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** One creature kind per species of `t`. Throws if a species has no natural weapon. */
export function wildlifeCreatures(t: WildlifeTable, natural: NaturalWeapons): CreaturesRules["creatures"] {
  const out: CreaturesRules["creatures"] = {};
  for (const [id, s] of Object.entries(t.species)) {
    const weapon = natural.species[id] ?? natural.byRole[s.role];
    if (!weapon) throw new Error(`wildlife: no natural weapon for "${id}" (role ${s.role}): add it to natural.json`);
    const tier = s.danger.tier;
    out[id] = {
      name: title(id),
      health: s.danger.health,
      aggroRadius: Math.max(1, s.danger.noticeM),
      leashRadius: clamp(s.territoryM * 0.2, 25, 150),
      respawnSeconds: 300,
      pack: [s.group.size[0], s.group.size[1]],
      weapons: [weapon],
      chaseSpeed: Math.min(1, 0.75 + 0.05 * tier),
      attackEverySeconds: 1.2 + 0.2 * tier,
      damageX: Math.max(0.01, s.danger.damageX),
      drops: { rolls: [0, 0], chance: 0 },
      behavior: {
        temperament: s.temperament,
        role: s.role,
        noticeM: Math.max(1, s.danger.noticeM),
        telegraphS: s.danger.telegraphS,
        wanderM: s.wanderM ?? 0,
        wanderPauseS: 6,
        ...(s.raid ? { raid: { ...s.raid, weights: { ...s.raid.weights } } } : {}),
        fleeSpeed: 1.4,
        tactics: s.danger.tactics,
        activity: s.activity,
        habitat: s.habitat === "water" ? "water" : "land",
        ...(s.depthM ? { depthM: [s.depthM[0], s.depthM[1]] as [number, number] } : {}),
        size: 1,
      },
    };
  }
  return out;
}

/** The table's kinds merged under existing rules (a kind the rules already define wins: editing it is the editor's). */
export function withWildlife(base: CreaturesRules["creatures"], generated: CreaturesRules["creatures"]): CreaturesRules["creatures"] {
  return { ...generated, ...base };
}
