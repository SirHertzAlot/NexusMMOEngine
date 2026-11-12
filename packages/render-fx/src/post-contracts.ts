/**
 * Post-processing buffer contracts [PROPOSED, PR1].
 * packages/render-fx/src/post-contracts.ts — types only, no postprocessing import.
 *
 * Verified rules (spec section 9):
 * - Depth readers (N8AO, UnderwaterEffect with EffectAttribute.DEPTH) MUST
 *   run before any pass after which the depth attachment is unavailable.
 * - Colour-only passes (Kuwahara paint, bloom, grade, tonemap) follow paint.
 * - Tone mapping + sRGB encode run once at the end; UI composites after.
 */
import type { FxTier } from "./types.js";

export type PassKind = "depth-reader" | "paint" | "colour" | "tonemap" | "ui";

export interface PassContract {
  /** Pass display name (e.g. "N8AO", "Kuwahara", "Bloom"). */
  name: string;
  kind: PassKind;
  /** True when the pass consumes the composer's depth attachment. */
  readsDepth: boolean;
  /** True when the pass rotates/invalidates the depth attachment for later passes. */
  consumesDepth: boolean;
}

/**
 * Canonical frame-graph order. A pass may run at index i only if every
 * depth-reader runs before the first depth-consuming pass, paint precedes
 * colour passes, and tonemap is last before UI.
 */
export const FRAME_GRAPH_ORDER: readonly PassKind[] = [
  "depth-reader",
  "paint",
  "colour",
  "tonemap",
  "ui",
] as const;

export function passOrderIndex(kind: PassKind): number {
  return FRAME_GRAPH_ORDER.indexOf(kind);
}

/** Kuwahara radius tier table [TARGET — gated by measurement in the post PR]. */
export const KUWAHARA_TIER_TABLE: Record<FxTier, { enabled: boolean; radius: number; halfRes: boolean }> = {
  low: { enabled: false, radius: 0, halfRes: true },
  medium: { enabled: true, radius: 2, halfRes: true },
  high: { enabled: true, radius: 3, halfRes: false },
  ultra: { enabled: true, radius: 4, halfRes: false },
};

export interface FrameGraphValidation {
  ok: boolean;
  issues: string[];
}

/** Validate a pass list against the canonical order. Equal stages may repeat
 *  (e.g. two depth readers); jumping backward skips a stage and is rejected;
 *  any depth read after consumption is rejected. */
export function validateFrameGraph(passes: PassContract[]): FrameGraphValidation {
  const issues: string[] = [];
  let maxSeen = -1;
  let depthGone = false;
  for (const p of passes) {
    const idx = passOrderIndex(p.kind);
    if (idx < 0) {
      issues.push(`${p.name}: unknown pass kind`);
      continue;
    }
    if (idx < maxSeen) issues.push(`${p.name}: ${p.kind} runs after a later stage`);
    maxSeen = Math.max(maxSeen, idx);
    if (p.readsDepth && depthGone) issues.push(`${p.name}: reads depth after it was consumed`);
    if (p.consumesDepth) depthGone = true;
  }
  return { ok: issues.length === 0, issues };
}
