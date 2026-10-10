/**
 * Rename a quest id across the story documents (Story tree, "Rename id…").
 *
 * The id is a key in quests.json and is named by other quests' `after`
 * lists and by dialog replies (`if.quest`, `do.accept`, `do.complete`).
 * Returns the two changed documents; the host saves them together, so the
 * server's own checks see the renamed set and refuse a broken one.
 */

import type { StoryFiles } from "./story-validate.js";

const ID = /^[a-z][a-z0-9-]*$/;

interface Reply { if?: { quest?: string }; do?: { accept?: string; complete?: string } }

export function renameQuestId(files: StoryFiles, from: string, to: string): Pick<StoryFiles, "quests" | "dialogs"> {
  const quests = structuredClone(files.quests) as { quests: Record<string, { after?: string[] }> };
  const dialogs = structuredClone(files.dialogs) as { dialogs: Record<string, { nodes: Record<string, { replies: Reply[] }> }> };
  if (!ID.test(to)) throw new Error("A quest id is lowercase letters, digits and dashes, starting with a letter");
  if (!(from in quests.quests)) throw new Error(`No quest "${from}"`);
  if (from === to) throw new Error("The new id is the same");
  if (to in quests.quests) throw new Error(`A quest "${to}" already exists`);
  quests.quests = Object.fromEntries(Object.entries(quests.quests).map(([k, v]) => [k === from ? to : k, v]));
  for (const q of Object.values(quests.quests)) if (q.after) q.after = q.after.map((a) => (a === from ? to : a));
  for (const d of Object.values(dialogs.dialogs)) {
    for (const n of Object.values(d.nodes)) {
      for (const r of n.replies) {
        if (r.if?.quest === from) r.if.quest = to;
        if (r.do?.accept === from) r.do.accept = to;
        if (r.do?.complete === from) r.do.complete = to;
      }
    }
  }
  return { quests, dialogs };
}
