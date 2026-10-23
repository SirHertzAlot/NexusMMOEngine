/**
 * The fortify loop: the castle-evolution algorithm itself.
 *
 *   analyze → take the worst weakness → apply the cheapest counter the
 *   matrix offers for it (that this settlement can actually build) →
 *   re-analyze → repeat until total exposure meets the threshold, the
 *   defence budget runs out, or nothing applicable remains.
 *
 * Every application is a small, legible mutation of the settlement —
 * bend the approach, raise a barbican, plant a flanking tower where the
 * dead ground actually is, rebuild a tower round, dig a moat — and the
 * build log records each one with the exposure it bought. That log is
 * the settlement's architectural history, and it is fully determined by
 * (settlement, seed, budget, era).
 */

import { idx, tx, ty, cloneSettlement, rng, type Settlement } from "./model.js";
import {
  DEFAULT_MATRIX,
  type CounterDef,
  type CounterId,
  type Matrix,
  type WeaknessKind,
} from "./matrix.js";
import { analyze, faceSamples, moatFeasible, wallFaces, type Analysis, type Weakness } from "./analyze.js";

export interface FortifyOptions {
  /** Defence-budget points the settlement may spend. */
  budget: number;
  /** Stop when total exposure is at or below this (default 0.25). */
  threshold?: number;
  /** Counters above this era do not exist yet (default: no gate). */
  era?: number;
  seed?: number;
  matrix?: Matrix;
  maxSteps?: number;
  /** Called with a snapshot after each counter is applied (frame export, tracing). */
  onStep?: (snapshot: Settlement, step: BuildStep) => void;
}

export interface BuildStep {
  step: number;
  weaknessKind: WeaknessKind;
  weaknessDetail: string;
  counter: CounterId;
  cost: number;
  /** Total exposure before / after this application (after = next analysis). */
  totalBefore: number;
  totalAfter: number;
}

export type StopReason = "threshold-met" | "budget-exhausted" | "no-applicable-counter" | "max-steps";

export interface FortifyResult {
  settlement: Settlement;
  log: BuildStep[];
  spent: number;
  stopReason: StopReason;
  analysis: Analysis;
}

/** Has the bend already been built? (Islands in the approach say yes.) */
const bent = (s: Settlement): boolean => s.islands.size > 0;

/**
 * Can `counter` be applied to `w` in this settlement right now?
 * Applicability is physical, not just budgetary: a moat needs water to
 * divert, a round tower needs a square tower, a bend needs an unbent
 * approach.
 */
export function canApply(s: Settlement, counter: CounterId, w: Weakness): boolean {
  switch (counter) {
    case "bend-approach":
      return w.site.kind === "approach" && !bent(s);
    case "barbican":
      return w.site.kind === "approach" && s.barbican === null;
    case "flanking-tower":
      return w.site.kind === "face" && faceSamples(s, w.site.face).dead.length > 0;
    case "round-tower":
      return (
        w.site.kind === "structure" &&
        w.site.structure === "tower" &&
        s.towers.some((t) => t.x === (w.site as { x: number }).x && t.y === (w.site as { y: number }).y && t.form === "square")
      );
    case "moat":
      return w.site.kind === "structure" && moatFeasible(s, w.site.x, w.site.y);
  }
}

/**
 * Apply one counter to the settlement, in place. Returns false if the
 * application turned out to be impossible (callers should gate on
 * `canApply` first).
 */
export function applyCounter(s: Settlement, counter: CounterId, w: Weakness, rand: () => number): boolean {
  const g = s.grid;
  switch (counter) {
    case "bend-approach": {
      // Rebuild the causeway with a Z-bend near the gate: leave the road,
      // jog sideways for two rows, come back. The old straight tile
      // becomes an island, so the cheap path must turn with the road.
      // (Prototype: the fixture's gate is on the south face; the bend is
      // built in the five approach rows outside it.)
      if (w.site.kind !== "approach" || bent(s)) return false;
      const gx = tx(g, s.gate);
      const gy = ty(g, s.gate);
      const side = rand() < 0.5 ? -1 : 1;
      const ox = gx + 2 * side;
      const road = (x: number, y: number) => {
        const i = idx(g, x, y);
        s.grid.tiles[i] = { terrain: "road", diggable: true, waterDepth: s.grid.tiles[i].waterDepth };
      };
      road(gx + side, gy + 5);
      road(ox, gy + 5);
      road(ox, gy + 4);
      road(ox, gy + 3);
      road(gx + side, gy + 3);
      // Keep (gx, gy+3) as the return leg; drown the old straight tile.
      const old = idx(g, gx, gy + 4);
      s.grid.tiles[old] = { terrain: "water", diggable: false, waterDepth: 0 };
      s.islands.add(old);
      return true;
    }
    case "barbican": {
      // A second gated guardhouse three tiles out on the approach.
      if (w.site.kind !== "approach" || s.barbican !== null) return false;
      const gx = tx(g, s.gate);
      const gy = ty(g, s.gate);
      const i = idx(g, gx, gy + 3);
      if (s.grid.tiles[i].terrain !== "road") return false;
      s.barbican = i;
      return true;
    }
    case "flanking-tower": {
      // Plant the tower on the face's wall tile nearest the centroid of
      // the dead sample points — where the dead ground actually is.
      if (w.site.kind !== "face") return false;
      const { dead } = faceSamples(s, w.site.face);
      if (dead.length === 0) return false;
      const cx = dead.reduce((a, p) => a + p.x, 0) / dead.length;
      const cy = dead.reduce((a, p) => a + p.y, 0) / dead.length;
      const tiles = wallFaces(s)[w.site.face];
      let best = -1;
      let bestD = Infinity;
      for (const i of tiles) {
        if (s.towers.some((t) => t.x === tx(g, i) && t.y === ty(g, i))) continue;
        const d = Math.hypot(tx(g, i) - cx, ty(g, i) - cy);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best === -1) return false;
      s.towers.push({ x: tx(g, best), y: ty(g, best), form: "square" });
      return true;
    }
    case "round-tower": {
      if (w.site.kind !== "structure") return false;
      const { x: sx, y: sy } = w.site;
      const t = s.towers.find((t) => t.x === sx && t.y === sy);
      if (!t || t.form !== "square") return false;
      t.form = "round";
      return true;
    }
    case "moat": {
      // Flood the ground just outside the structure: every tile a sap
      // could start from becomes water.
      if (w.site.kind !== "structure") return false;
      const { x, y } = w.site;
      let dug = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
        const i = idx(g, nx, ny);
        if (s.walls.has(i)) continue;
        s.grid.tiles[i] = { terrain: "water", diggable: false, waterDepth: 0 };
        s.moat.add(i);
        dug = true;
      }
      return dug;
    }
  }
}

const siteKey = (w: Weakness): string => {
  const s = w.site;
  switch (s.kind) {
    case "approach":
      return `${w.kind}:approach`;
    case "face":
      return `${w.kind}:${s.face}`;
    case "structure":
      return `${w.kind}:${s.x},${s.y}`;
  }
};

/** Run the loop. The input settlement is not mutated. */
export function fortify(input: Settlement, opts: FortifyOptions): FortifyResult {
  const matrix = opts.matrix ?? DEFAULT_MATRIX;
  const threshold = opts.threshold ?? 0.25;
  const era = opts.era ?? Number.POSITIVE_INFINITY;
  const maxSteps = opts.maxSteps ?? 24;
  const rand = rng(opts.seed ?? 1);
  const s = cloneSettlement(input);
  const log: BuildStep[] = [];
  const unfixable = new Set<string>();
  let spent = 0;
  let stopReason: StopReason = "max-steps";
  let analysis = analyze(s, matrix);

  for (let step = 1; step <= maxSteps; step++) {
    analysis = analyze(s, matrix);
    // "Done" means the total is under budget AND no single weakness is
    // still glaring — a town whose gate can be sapped is not fortified
    // just because its average looks fine.
    if (analysis.total <= threshold && analysis.weaknesses.every((w) => w.severity <= threshold)) {
      stopReason = "threshold-met";
      break;
    }
    // Worst fixable weakness first (analysis is severity-sorted).
    let chosen: { w: Weakness; counter: CounterDef } | null = null;
    let sawUnaffordable = false;
    for (const w of analysis.weaknesses) {
      if (unfixable.has(siteKey(w))) continue;
      const options = matrix.counters
        .filter((c) => c.clears === w.kind && c.era <= era && canApply(s, c.id, w))
        .sort((a, b) => a.cost - b.cost);
      if (options.length === 0) continue;
      if (options[0].cost > opts.budget - spent) {
        sawUnaffordable = true;
        continue;
      }
      chosen = { w, counter: options[0] };
      break;
    }
    if (!chosen) {
      stopReason = sawUnaffordable ? "budget-exhausted" : "no-applicable-counter";
      break;
    }
    const before = analysis.total;
    if (!applyCounter(s, chosen.counter.id, chosen.w, rand)) {
      unfixable.add(siteKey(chosen.w));
      continue;
    }
    spent += chosen.counter.cost;
    const after = analyze(s, matrix).total;
    const entry: BuildStep = {
      step,
      weaknessKind: chosen.w.kind,
      weaknessDetail: chosen.w.detail,
      counter: chosen.counter.id,
      cost: chosen.counter.cost,
      totalBefore: before,
      totalAfter: after,
    };
    log.push(entry);
    opts.onStep?.(cloneSettlement(s), entry);
    if (step === maxSteps) stopReason = "max-steps";
  }

  return { settlement: s, log, spent, stopReason, analysis: analyze(s, matrix) };
}
