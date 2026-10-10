/** Browser-safe client of GET /api/editor/problems (problems-host.ts) and the deep link each problem opens. */
import type { Problem, ProblemSource } from "./problems-host.js";

export type { Problem };

export interface ProblemList {
  problems: Problem[];
  errors: number;
  warnings: number;
}

export async function loadProblems(): Promise<ProblemList> {
  const res = await fetch("/api/editor/problems");
  const b = (await res.json().catch(() => ({}))) as Partial<ProblemList> & { error?: string };
  if (!res.ok || !b.problems) throw new Error(b.error ?? `HTTP ${res.status}`);
  return { problems: b.problems, errors: b.errors ?? 0, warnings: b.warnings ?? 0 };
}

const LINKS: Record<ProblemSource, string> = {
  flow: "#/flow/flow",
  hud: "#/release/hud",
  strings: "#/story/strings",
  audio: "#/artaudio/audio",
  vfx: "#/artaudio/vfx",
  animation: "#/artaudio/animation",
  gameplay: "#/gameplay/grids",
  rules: "#/gameplay/rules",
  scenes: "#/scenes/scene",
  modules: "#/modules/modules",
  story: "#/story/story-editor",
  build: "#/release/pipeline",
  playtest: "#/release/playtests",
};

/** The workspace view that owns a problem (a deep link, #/<workspace>/<view>). */
export const problemLink = (p: Pick<Problem, "source">): string => LINKS[p.source];
