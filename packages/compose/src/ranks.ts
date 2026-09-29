/**
 * The rank ladder: how many ranks there are, what each is called, its
 * share of all loot, its power budget, and the signals that show it.
 *
 * Shares follow one rule. With N ranks, 100% starts divided evenly
 * (100/N each). It is then tilted until each rank takes less than the
 * one below it: the lowest rank takes the most and the highest the
 * least, still adding up to exactly 100%. The tilt is linear. By
 * default the highest rank ends at half the even share, so five ranks
 * give 30 / 25 / 20 / 15 / 10 (legendary 10%). A game tunes the shares
 * from there, and the checks keep them descending and summing to 100.
 *
 * Names are inferred from the count (common … legendary, then mythic
 * and divine), or given. Budgets grow with rank, from 1 at the bottom to
 * 11 at the top, triangularly between (five ranks: 1, 2, 4, 7, 11).
 * Signals switch on up the ladder: a tint, then particles, then an aura
 * and runes, and at the top a unique ability and body transforms.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

/** Canonical names, lowest first, and which of them a ladder of N ranks uses. */
const NAMES_BY_COUNT: Record<number, readonly string[]> = {
  1: ["common"],
  2: ["common", "legendary"],
  3: ["common", "rare", "legendary"],
  4: ["common", "rare", "epic", "legendary"],
  5: ["common", "uncommon", "rare", "epic", "legendary"],
  6: ["common", "uncommon", "rare", "epic", "legendary", "mythic"],
  7: ["common", "uncommon", "rare", "epic", "legendary", "mythic", "divine"],
};

/** Rank names for a ladder of `n` (beyond 7: divine-2, divine-3, …). */
export function inferRankNames(n: number): string[] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`a ladder needs at least one rank (got ${n})`);
  if (n <= 7) return [...NAMES_BY_COUNT[n]];
  return [...NAMES_BY_COUNT[7], ...Array.from({ length: n - 7 }, (_, i) => `divine-${i + 2}`)];
}

/**
 * Shares (percent, to 0.01) for `n` ranks, lowest rank first: 100/n each,
 * tilted linearly so they strictly fall and the highest rank takes `top`
 * (default: half the even share). Always sums to exactly 100.
 */
export function rankShares(n: number, top = 100 / n / 2): number[] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`a ladder needs at least one rank (got ${n})`);
  if (n === 1) return [100];
  const even = 100 / n;
  if (!(top > 0 && top < even)) throw new Error(`the highest rank's share must be above 0 and below the even share ${even.toFixed(2)}% (got ${top})`);
  // Linear: share_k = even + d * ((n-1)/2 - k); share_{n-1} = top.
  const d = ((even - top) * 2) / (n - 1);
  const exact = Array.from({ length: n }, (_, k) => even + d * ((n - 1) / 2 - k));
  return toHundredths(exact);
}

/** Round percentages to 0.01 so they still sum to exactly 100 (largest remainder). */
function toHundredths(exact: number[]): number[] {
  const units = exact.map((s) => Math.floor(s * 100 + 1e-9));
  let left = 10000 - units.reduce((a, b) => a + b, 0);
  const order = exact.map((s, k) => ({ k, r: s * 100 - Math.floor(s * 100 + 1e-9) })).sort((a, b) => b.r - a.r || a.k - b.k);
  for (let i = 0; left > 0; i = (i + 1) % order.length, left--) units[order[i].k]++;
  return units.map((u) => u / 100);
}

/**
 * Budget of the rank at `k` (0 lowest) of `n`: 1 at the bottom, 11 at the
 * top, triangular between, always rising (five ranks: 1, 2, 4, 7, 11).
 */
export function rankBudget(k: number, n: number): number {
  let b = 1;
  const T = (i: number): number => (i * (i + 1)) / 2;
  for (let i = 1; i <= k; i++) b = Math.max(b + 1, Math.round(1 + (10 * T(i)) / T(n - 1)));
  return b;
}

export const SignalsSchema = z.strictObject({
  /** A palette shift (the rank's colour). */
  tint: z.boolean().default(false),
  particles: z.boolean().default(false),
  aura: z.boolean().default(false),
  /** Carved, glowing runes. */
  runes: z.boolean().default(false),
  /** An ability no lower rank can have. */
  uniqueAbility: z.boolean().default(false),
  /** Proportion and animation transforms (a larger frame, a spectral gait). */
  transforms: z.boolean().default(false),
});
export type Signals = z.infer<typeof SignalsSchema>;

/** The signals a rank shows, from where it sits on the ladder (0 lowest … 1 highest). */
export function signalsAt(t: number, top: boolean): Signals {
  return {
    tint: t >= 0.25,
    particles: t >= 0.5,
    aura: t >= 0.75,
    runes: t >= 0.75,
    uniqueAbility: top && t > 0,
    transforms: top && t > 0,
  };
}

export const RankSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  /** Percent of all loot. */
  share: z.number().gt(0).max(100),
  /** Power budget for composing an entity of this rank. */
  budget: z.number().int().min(0),
  /** The rank's colour (sRGB hex), for tints and UI. */
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  signals: SignalsSchema.prefault({}),
});
export type Rank = z.infer<typeof RankSchema>;

export const LadderSchema = z.strictObject({ ranks: z.array(RankSchema).min(1) });
export type Ladder = z.infer<typeof LadderSchema>;

const COLORS = ["#b8b8b8", "#3fbf4f", "#3f7fdf", "#a347e0", "#f09a1a", "#e8453c", "#f2e6a0"];

/** A ladder from rank names (lowest first) or a count, with the default shares, budgets, colours and signals. */
export function buildLadder(names: readonly string[] | number, opts: { top?: number } = {}): Ladder {
  const ids = typeof names === "number" ? inferRankNames(names) : [...names];
  const n = ids.length;
  const shares = rankShares(n, opts.top);
  const ranks = ids.map((id, k) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, " "),
    share: shares[k],
    budget: rankBudget(k, n),
    color: COLORS[Math.min(k, COLORS.length - 1)],
    signals: signalsAt(n === 1 ? 0 : k / (n - 1), k === n - 1),
  }));
  return checkLadder({ ranks });
}

/** Every problem with a ladder: names unique, shares strictly falling and summing to 100, budgets rising. */
export function ladderProblems(l: Ladder): string[] {
  const p: string[] = [];
  const seen = new Set<string>();
  const sum = l.ranks.reduce((s, r) => s + r.share, 0);
  if (Math.abs(sum - 100) > 1e-6) p.push(`shares sum to ${Number(sum.toFixed(6))}%, not 100%`);
  l.ranks.forEach((r, k) => {
    if (seen.has(r.id)) p.push(`${r.id}: named twice`);
    seen.add(r.id);
    if (k === 0) return;
    const below = l.ranks[k - 1];
    if (r.share >= below.share) p.push(`${r.id}: its share (${r.share}%) must be below ${below.id}'s (${below.share}%)`);
    if (r.budget <= below.budget) p.push(`${r.id}: its budget (${r.budget}) must be above ${below.id}'s (${below.budget})`);
  });
  return p;
}

function checkLadder(l: Ladder): Ladder {
  const p = ladderProblems(l);
  if (p.length) throw new Error(`rank ladder:\n${p.map((x) => `  ${x}`).join("\n")}`);
  return l;
}

/** The default ladder: five ranks, common … legendary. */
export const DEFAULT_LADDER: Ladder = buildLadder(5);

/**
 * A ladder from a file: either `{ "ranks": ["common", "rare", …] }` (names,
 * everything else by the rules above) or full ranks. Throws with every problem.
 */
export function loadLadder(file?: string): Ladder {
  if (!file) return DEFAULT_LADDER;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  const names = z.strictObject({ ranks: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1), top: z.number().optional() }).safeParse(raw);
  if (names.success) return buildLadder(names.data.ranks, { top: names.data.top });
  const full = LadderSchema.safeParse(raw);
  if (!full.success) throw new Error(`${file}:\n${full.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  const p = ladderProblems(full.data);
  if (p.length) throw new Error(`${file}:\n${p.map((x) => `  ${x}`).join("\n")}`);
  return full.data;
}

/** The rank with this id, and its index (0 lowest). */
export function rankOf(l: Ladder, id: string): { rank: Rank; index: number } {
  const index = l.ranks.findIndex((r) => r.id === id);
  if (index < 0) throw new Error(`no rank "${id}" (have: ${l.ranks.map((r) => r.id).join(", ")})`);
  return { rank: l.ranks[index], index };
}
