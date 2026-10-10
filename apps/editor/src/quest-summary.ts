/**
 * Quests workspace data (roadmap EA26): the authored quests in
 * content/quests, summarized for reading. Pure; the files come from the
 * Story host (story-client.ts loadStory).
 */
import type { QuestsDoc } from "./story-model.js";

export interface QuestRow {
  id: string;
  name: string;
  giver: string;
  giverName: string;
  summary: string;
  steps: Array<{ id: string; text: string; objective: string }>;
  rewards: string;
  after: string[];
  repeatable: boolean;
}

/** `kill goblin ×3`, `talk warden`, `reach the old watchtower`. */
export function objectiveLabel(o: Record<string, unknown>): string {
  const type = typeof o.type === "string" ? o.type : "?";
  const what = [o.kind, o.npc, o.place, o.item, o.base].find((v) => typeof v === "string");
  const count = typeof o.count === "number" && o.count > 1 ? ` ×${o.count}` : "";
  return `${type}${what ? ` ${String(what)}` : ""}${count}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One row per quest in file order; tolerant of a half-edited document (rows it cannot read are skipped). */
export function summarizeQuests(quests: unknown, npcs: unknown): QuestRow[] {
  const q = isObj(quests) && isObj((quests as Partial<QuestsDoc>).quests) ? (quests as unknown as QuestsDoc).quests : {};
  const names = isObj(npcs) && isObj(npcs.npcs) ? (npcs.npcs as Record<string, { name?: unknown }>) : {};
  return Object.entries(q).flatMap(([id, d]) => {
    if (!isObj(d) || !Array.isArray(d.steps)) return [];
    const npcName = names[d.giver]?.name;
    return [{
      id,
      name: typeof d.name === "string" ? d.name : id,
      giver: d.giver,
      giverName: typeof npcName === "string" ? npcName : d.giver,
      summary: typeof d.summary === "string" ? d.summary : "",
      steps: d.steps.filter(isObj).map((s) => ({ id: String(s.id), text: String(s.text ?? ""), objective: objectiveLabel(isObj(s.objective) ? s.objective : {}) })),
      rewards: (d.rewards ?? []).map((r) => `${r.base}${r.count && r.count > 1 ? ` ×${r.count}` : ""}`).join(", "),
      after: Array.isArray(d.after) ? d.after : [],
      repeatable: d.repeatable === true,
    }];
  });
}
