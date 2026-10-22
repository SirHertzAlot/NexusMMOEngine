/**
 * Dungeon prop art: which of the local art catalog's models stands in for a prop kind, by name. The patterns are generic
 * words, no catalog data; the result is the git-ignored overlay `content/dungeons/props.local.json` the server reads over
 * `props.json` (engine-core `content.ts`), because a prop's AssetRef hash is the hash of its asset id and the client draws a
 * pack model when that id is a catalog model's id.
 *
 * Matching is conservative, on whole name words: a wrong model is worse than the procedural mesh (a pillar must not be a
 * Caterpillar, a table the Stables), so patterns name what to avoid, and a kind with no pattern is always procedural.
 */

import { writeFileSync } from "node:fs";

export interface CatalogModel {
  id: string;
  name: string;
  skinned?: boolean;
  triangles?: number;
  size?: [number, number, number];
}

/**
 * A model name as lower-case words: split at anything that is not a letter or digit and at camelCase joins, digits dropped
 * (`SM_Prop_WeaponRack_01` is sm prop weapon rack). Matching whole words keeps `pillar` off `Caterpillar`, `crate` off
 * `Crater` and `table` off `Stables`.
 */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w !== "" && !/^\d+$/.test(w));
}

/** Words no prop model should have, whatever the kind: building and character parts, effects, damage, props' lids. */
const NEVER = ["bld", "chr", "fx", "particle", "lid", "broken", "damaged", "destroyed", "speaker", "skeleton"];

/**
 * Prop kind to the word sequence its model's name must contain (`words`, in order, next to each other) and the words it must
 * not (`avoid`). Kinds not listed stay procedural.
 */
export const DUNGEON_ART_PATTERNS: Record<string, { words: string[]; avoid?: string[] }> = {
  "weapon-rack": { words: ["weapon", "rack"] },
  barrel: { words: ["barrel"] },
  chest: { words: ["chest"], avoid: ["plate", "armour", "armor", "rib", "drawer", "pile"] },
  crate: { words: ["crate"] },
  statue: { words: ["statue"], avoid: ["fountain", "head"] },
  brazier: { words: ["brazier"] },
  throne: { words: ["throne"] },
  anvil: { words: ["anvil"] },
  coffin: { words: ["coffin"] },
  torch: { words: ["torch"] },
  pillar: { words: ["pillar"], avoid: ["ceiling", "stump", "small", "base"] },
  rubble: { words: ["rubble"], avoid: ["wall"] },
  table: { words: ["table"], avoid: ["desk", "picnic"] },
  candles: { words: ["candles"] },
  sack: { words: ["sack"], avoid: ["hanging"] },
  pew: { words: ["pew"] },
};

const hasRun = (words: readonly string[], run: readonly string[]): boolean => words.some((_, i) => run.every((r, j) => words[i + j] === r));

export interface ArtMatch {
  assets: Record<string, string>;
  unmatched: string[];
  contact: { kind: string; model: string; name: string; candidates: number; triangles?: number; size?: [number, number, number] }[];
}

/** Match `kinds` to `models`: per kind the first (by name, then id) unskinned model that fits its pattern. */
export function matchProps(models: readonly CatalogModel[], kinds: readonly string[]): ArtMatch {
  const sorted = [...models].filter((x) => !x.skinned).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
  const out: ArtMatch = { assets: {}, unmatched: [], contact: [] };
  for (const kind of kinds) {
    const pat = DUNGEON_ART_PATTERNS[kind];
    const hits = pat
      ? sorted.filter((x) => {
          const words = nameWords(x.name);
          return hasRun(words, pat.words) && !words.some((w) => NEVER.includes(w) || pat.avoid?.includes(w));
        })
      : [];
    if (hits.length === 0) {
      out.unmatched.push(kind);
      continue;
    }
    const [first] = hits;
    out.assets[kind] = first.id;
    out.contact.push({ kind, model: first.id, name: first.name, candidates: hits.length, ...(first.triangles !== undefined ? { triangles: first.triangles } : {}), ...(first.size ? { size: first.size } : {}) });
  }
  return out;
}

/** Match and write the overlay (`{ version: 1, assets }`, kinds in order) to `file`. */
export function writeArtOverlay(models: readonly CatalogModel[], kinds: readonly string[], file: string): ArtMatch {
  const match = matchProps(models, kinds);
  const assets = Object.fromEntries(Object.entries(match.assets).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(file, JSON.stringify({ version: 1, assets }, null, 2) + "\n");
  return match;
}
