/**
 * Clip-name normalisation for imported animal packs (WL2 placeholder art). The CC0 Gobkit curated
 * packs name their locomotion `walk` and have no `dead` clip; the community library uses `move` and
 * `idle` / `attack` only. The rig and the importer both ask for canonical names through this map.
 */

export type CanonicalClip = "idle" | "walk" | "run" | "attack" | "dead";

/** Source clip name (lower case) to canonical name. Unknown names map to nothing. */
const ALIASES: Record<string, CanonicalClip> = {
  idle: "idle", stand: "idle", rest: "idle",
  walk: "walk", move: "walk", locomotion: "walk",
  run: "run", gallop: "run", trot: "run",
  attack: "attack", bite: "attack", strike: "attack",
  dead: "dead", death: "dead", die: "dead", dying: "dead",
};

/** The canonical name of a source clip, or null when the rig has no use for it. */
export function canonicalClip(source: string): CanonicalClip | null {
  return ALIASES[source.trim().toLowerCase()] ?? null;
}

/**
 * Pick one source clip per canonical name, first match wins. A pack with no `dead` clip gets
 * none, and the rig falls back to its procedural fall (`deathProgress`).
 */
export function mapClips(sources: readonly string[]): Partial<Record<CanonicalClip, string>> {
  const out: Partial<Record<CanonicalClip, string>> = {};
  for (const name of sources) {
    const c = canonicalClip(name);
    if (c && out[c] === undefined) out[c] = name;
  }
  return out;
}
