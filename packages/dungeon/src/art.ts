/**
 * Dungeon prop art: which of the local art catalog's models stands in for a prop kind, by name. The patterns are generic
 * words, no catalog data; the result is the git-ignored overlay `content/dungeons/props.local.json` the server reads over
 * `props.json` (engine-core `content.ts`), because a prop's AssetRef hash is the hash of its asset id and the client draws a
 * pack model when that id is a catalog model's id.
 *
 * Matching is conservative: a wrong model is worse than the procedural mesh (cage must not take a ribcage, nor desk a
 * speaker), so every pattern names what to avoid, and a kind with no pattern is always procedural.
 */

import { writeFileSync } from "node:fs";

export interface CatalogModel {
  id: string;
  name: string;
  skinned?: boolean;
  triangles?: number;
  size?: [number, number, number];
}

/** Prop kind to the words its model's name must have (`match`) and must not have (`avoid`). Kinds not listed stay procedural. */
export const DUNGEON_ART_PATTERNS: Record<string, { match: RegExp; avoid?: RegExp }> = {
  "weapon-rack": { match: /weapon.?rack/i },
  barrel: { match: /barrel/i, avoid: /broken|lid/i },
  chest: { match: /chest/i, avoid: /lid|plate|armou?r|rib|drawer|treasure.?pile/i },
  crate: { match: /crate/i, avoid: /broken/i },
  statue: { match: /statue/i, avoid: /broken|head_only/i },
  brazier: { match: /brazier/i },
  throne: { match: /throne/i },
  anvil: { match: /anvil/i },
  coffin: { match: /coffin/i, avoid: /lid/i },
  torch: { match: /torch/i, avoid: /lid|particle|wall_bracket_only/i },
  pillar: { match: /pillar/i, avoid: /ceiling|broken|stump|small|base_only/i },
  rubble: { match: /rubble/i },
  table: { match: /table/i, avoid: /skeleton|speaker|desk|picnic/i },
  candles: { match: /candles/i, avoid: /particle/i },
  sack: { match: /sack/i, avoid: /hanging/i },
  pew: { match: /\bpew\b|_pew_|pew_/i },
};

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
    const hits = pat ? sorted.filter((x) => pat.match.test(x.name) && !(pat.avoid && pat.avoid.test(x.name))) : [];
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
