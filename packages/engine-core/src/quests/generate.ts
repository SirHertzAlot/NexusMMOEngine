/**
 * Generated quests (roadmap P1, DUNGEONS-AND-LOOT.md §2.3): a template's
 * stages are WFC slots, each taking one step type of its stage. Every pair of
 * slots shares a "seq" edge, under which
 *
 *  - a step's `needs` tags must be given by some other step (the content
 *    check guarantees givers sit in earlier stages, so "a twist needs an
 *    earlier ally" holds);
 *  - two steps that `excludes` each other's tags never share a quest, nor
 *    does one step type twice.
 *
 * Steps whose bindings can't be met here (a reach step where the giver has
 * no places, a kill step with no creatures near) are out of their slot's
 * domain. The solved steps are then bound to the world: one creature kind,
 * one place and one item per quest, counts drawn from their ranges, and text
 * filled in. Pure: the same content, bindings and seed give the same quest.
 */

import { mulberry32, solve, type WfcNeed, type WfcOption, type WfcProblem } from "@mmo-engine/wfc";
import type { Objective, QuestContent, StepType } from "./content.js";
import { concrete, type QuestDef, type QuestStep } from "./quest-def.js";

export interface QuestBindings {
  /** The npc offering the quest. */
  giver: string;
  /** Creature kinds that live near the giver (id, display name, and plural: default name + "s"). */
  species: readonly { id: string; name: string; plural?: string }[];
  /** Item bases a collect step or a `$item` reward may name. */
  items: readonly string[];
}

export class QuestGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestGenerationError";
  }
}

function bindingsOf(o: Objective): string[] {
  const v = o.type === "talk" ? o.npc : o.type === "kill" ? o.kind : o.type === "reach" ? o.place : o.base;
  return v.startsWith("$") ? [v] : [];
}

/** Collapse template `templateId` into a concrete quest for `bindings`, by `seed`. */
export function generateQuest(content: QuestContent, templateId: string, bindings: QuestBindings, seed: number): QuestDef {
  const template = content.templates[templateId];
  if (!template) throw new QuestGenerationError(`unknown template "${templateId}"`);
  const giver = content.npcs[bindings.giver];
  if (!giver) throw new QuestGenerationError(`unknown giver "${bindings.giver}"`);

  const ids = Object.keys(content.steps);
  const types: StepType[] = ids.map((i) => content.steps[i]);
  const options: WfcOption[] = ids.map((i, k) => ({ id: i, weight: types[k].weight, tags: types[k].gives }));
  const usable = (st: StepType): boolean =>
    bindingsOf(st.objective).every((b) =>
      b === "$place" ? giver.places.length > 0 : b === "$species" ? bindings.species.length > 0 : b === "$item" ? bindings.items.length > 0 : true,
    );
  const domains = template.stages.map((stage) => ids.flatMap((_, k) => (types[k].stage === stage && usable(types[k]) ? [k] : [])));
  for (let s = 0; s < domains.length; s++) {
    if (domains[s].length === 0) throw new QuestGenerationError(`template "${templateId}": nothing can fill stage "${template.stages[s]}" for ${bindings.giver}`);
  }
  const edges = [];
  for (let a = 0; a < template.stages.length; a++) for (let b = a + 1; b < template.stages.length; b++) edges.push({ a, b, rule: "seq" });
  const needs: WfcNeed[] = [];
  types.forEach((st, k) => {
    for (const tag of st.needs) {
      needs.push({ option: k, from: types.flatMap((o, j) => (o.gives.includes(tag) ? [j] : [])), rule: "seq" });
    }
  });
  const clash = (x: StepType, y: StepType): boolean => x.excludes.some((t) => y.gives.includes(t)) || y.excludes.some((t) => x.gives.includes(t));
  const problem: WfcProblem = {
    options,
    slots: template.stages.length,
    domains,
    edges,
    rules: { seq: (_x, _y, xi, yi) => xi !== yi && !clash(types[xi], types[yi]) },
    needs,
  };
  let solution;
  try {
    solution = solve(problem, { seed: seed >>> 0 });
  } catch (err) {
    throw new QuestGenerationError(`template "${templateId}" for ${bindings.giver}: ${(err as Error).message}`);
  }

  // Bind the world: one of each per quest, drawn after the solve so the
  // step choice doesn't depend on what lives nearby.
  const rng = mulberry32((seed ^ 0x5eed9) >>> 0);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
  const species = bindings.species.length > 0 ? pick(bindings.species) : null;
  const place = giver.places.length > 0 ? pick(giver.places) : null;
  const item = bindings.items.length > 0 ? pick(bindings.items) : null;
  const sub = (v: string): string =>
    v === "$giver" ? bindings.giver : v === "$species" ? species!.id : v === "$place" ? place!.name : v === "$item" ? item! : v;
  const fill = (text: string, count?: number): string =>
    text
      .replaceAll("{giver}", giver.name)
      .replaceAll("{species}", (species?.plural ?? `${species?.name ?? "creature"}s`).toLowerCase())
      .replaceAll("{Species}", species ? species.name : "Creature")
      .replaceAll("{place}", place?.name ?? "the wilds")
      .replaceAll("{item}", `${item ?? "item"}${count !== undefined && count > 1 ? "s" : ""}`)
      .replaceAll("{count}", count === undefined ? "" : String(count));

  const steps: QuestStep[] = [];
  solution.assignment.forEach((k, slot) => {
    const st = types[k];
    const o = st.objective;
    const bound: Objective =
      o.type === "talk" ? { ...o, npc: sub(o.npc) } : o.type === "kill" ? { ...o, kind: sub(o.kind) } : o.type === "reach" ? { ...o, place: sub(o.place) } : { ...o, base: sub(o.base) };
    const objective = concrete(bound, content, giver, (min, max) => min + Math.floor(rng() * (max - min + 1)));
    const count = objective.type === "kill" || objective.type === "collect" ? objective.count : undefined;
    steps.push({ id: `${slot + 1}-${ids[k]}`, text: fill(st.text, count), objective });
  });
  return {
    id: `board:${bindings.giver}:${templateId}:${seed >>> 0}`,
    name: fill(template.name),
    giver: bindings.giver,
    summary: steps[0].text,
    steps,
    rewards: template.rewards.map((r) => ({ base: r.base === "$item" ? (item ?? r.base) : r.base, count: r.count, ...(r.gold !== undefined ? { gold: r.gold } : {}) })),
    repeatable: false,
    after: [],
  };
}
