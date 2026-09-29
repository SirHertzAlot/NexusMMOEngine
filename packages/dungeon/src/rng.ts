/**
 * The generator's randomness: one mulberry32 stream threaded through every
 * stage, so a seed rebuilds the same dungeon down to the last torch.
 * Ported from Dungeon Forge (MIT, © 2026 Majid Manzarpour; see
 * THIRD_PARTY_NOTICES.md). The order of draws is part of the format: a
 * change here changes every baked dungeon.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** Uniform in [a, b). */
  f(a: number, b: number): number;
  /** Integer in [a, b]. */
  i(a: number, b: number): number;
  pick<T>(list: readonly T[]): T;
  chance(p: number): boolean;
  raw: () => number;
}

export function makeRng(seed: number): Rng {
  const r = mulberry32(seed);
  return {
    f: (a, b) => a + r() * (b - a),
    i: (a, b) => a + Math.floor(r() * (b - a + 1)),
    pick: (list) => list[Math.floor(r() * list.length)],
    chance: (p) => r() < p,
    raw: r,
  };
}

/** A well-mixed u32 from a seed and an index (for deriving many seeds from one). */
export function deriveSeed(seed: number, index: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
