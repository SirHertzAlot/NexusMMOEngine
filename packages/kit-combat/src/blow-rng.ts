/**
 * The deterministic stream a blow is resolved from.
 *
 * It lived in `body.ts`, which made `combat.ts` unbuildable without the body
 * system beside it even though a blow's randomness has nothing to do with
 * parts: combat draws from it for defence too. It is three lines of integer
 * mixing and no state, so it sits on its own and both read it.
 *
 * Seeded by the tick and the two entities, so a replay of the same tick lands
 * the same blow — the thing the cross-CPU golden tests rest on.
 */
/** Deterministic 0..1 stream for one blow (mulberry32 over tick and the two entities). */
export function blowRng(tick: number, a: number, b: number): () => number {
  let s = (Math.imul(tick ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(a + 1, 0xc2b2ae35) ^ Math.imul(b + 7, 0x27d4eb2f)) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
