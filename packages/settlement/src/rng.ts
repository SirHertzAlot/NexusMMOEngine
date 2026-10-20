/**
 * One RNG stream per generation domain (terrain, districts, structures, ...),
 * each seeded from the world seed and the stream's name, so adding draws to
 * one stage never shifts another's. The streams are the wfc package's
 * mulberry32 and deriveSeed, shared with the dungeon bake.
 */

import { deriveSeed, mulberry32 } from "@mmo-engine/wfc";

export interface Rng {
  /** Uniform in [0, 1). */
  raw(): number;
}

/** FNV-1a: a stable u32 from a name. */
function nameHash(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class Streams {
  private readonly made = new Map<string, Rng>();
  private readonly seedOf = new Map<string, number>();
  constructor(private readonly seed: number) {}

  get(name: string): Rng {
    let r = this.made.get(name);
    if (!r) {
      const s = deriveSeed(this.seed, nameHash(name));
      r = { raw: mulberry32(s) };
      this.made.set(name, r);
      this.seedOf.set(name, s);
    }
    return r;
  }

  /** The seed of every stream made so far, by name, sorted (the manifest's `determinism`). */
  seeds(): Record<string, number> {
    return Object.fromEntries([...this.seedOf].sort(([a], [b]) => (a < b ? -1 : 1)));
  }
}

export const streams = (seed: number): Streams => new Streams(seed);

/** A seeded Fisher-Yates shuffle (a copy; `list` is left alone). */
export function shuffle<T>(list: readonly T[], rng: Rng): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.raw() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
