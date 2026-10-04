/**
 * Concrete quests (roadmap P1): what a character actually takes, tracks and
 * hands in. Authored quests become one directly; generated quests are
 * collapsed from a template by generate.ts. Either way every binding is
 * resolved here: a reach step carries its point, a kill step its count.
 */

import type { AuthoredQuest, NpcDef, Objective, QuestContent, RewardSpec } from "./content.js";

export type QuestObjective =
  | { type: "talk"; npc: string }
  | { type: "kill"; kind: string; count: number }
  | { type: "reach"; place: string; x: number; z: number; radius: number }
  | { type: "collect"; base: string; count: number };

export interface QuestStep {
  id: string;
  text: string;
  objective: QuestObjective;
}

export interface QuestDef {
  /** Authored: its content id. Generated: `board:<npc>:<template>:<seed>`. */
  id: string;
  name: string;
  /** The npc who gives it (and takes it back). */
  giver: string;
  summary: string;
  steps: QuestStep[];
  rewards: { base: string; count: number }[];
  repeatable: boolean;
  /** Quests that must be done first. */
  after: string[];
}

/** An authored quest as a concrete one: places resolved from its giver's (or any npc's) places. */
export function authoredQuest(content: QuestContent, id: string): QuestDef {
  const q: AuthoredQuest | undefined = content.quests[id];
  if (!q) throw new Error(`unknown quest "${id}"`);
  return {
    id,
    name: q.name,
    giver: q.giver,
    summary: q.summary,
    steps: q.steps.map((s) => ({ id: s.id, text: s.text, objective: concrete(s.objective, content, content.npcs[q.giver], () => 0) })),
    rewards: q.rewards.map((r: RewardSpec) => ({ base: r.base, count: r.count })),
    repeatable: q.repeatable,
    after: q.after,
  };
}

/** An objective with no bindings left (the caller substitutes them first); `draw` picks a count in a range. */
export function concrete(o: Objective, content: QuestContent, giver: NpcDef | undefined, draw: (min: number, max: number) => number): QuestObjective {
  const count = (c: number | [number, number]): number => (typeof c === "number" ? c : draw(c[0], c[1]));
  switch (o.type) {
    case "talk":
      return { type: "talk", npc: o.npc };
    case "kill":
      return { type: "kill", kind: o.kind, count: count(o.count) };
    case "collect":
      return { type: "collect", base: o.base, count: count(o.count) };
    case "reach": {
      const place = giver?.places.find((p) => p.name === o.place) ?? Object.values(content.npcs).flatMap((n) => n.places).find((p) => p.name === o.place);
      if (!place) throw new Error(`unknown place "${o.place}"`);
      return { type: "reach", place: place.name, x: place.x, z: place.z, radius: place.radius };
    }
  }
}

/** What an objective's progress counts up to (1 for talk and reach). */
export function objectiveTarget(o: QuestObjective): number {
  return o.type === "kill" || o.type === "collect" ? o.count : 1;
}
