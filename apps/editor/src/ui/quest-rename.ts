/**
 * "Rename id…" for a quest, shared by both quest trees of the Story
 * workspace: ask for the new id, send it through the host (which validates
 * the renamed set and writes quests and dialogs or neither), say what
 * happened. Resolves true when the id changed.
 */
import { renameQuestRemote, StorySaveError } from "../story-client.js";
import { notify } from "./components.js";

export async function renameQuestPrompt(from: string): Promise<boolean> {
  const to = window.prompt(`Rename quest id "${from}" to (lowercase letters, digits, dashes):`, from);
  if (!to || to === from) return false;
  try {
    await renameQuestRemote(from, to);
    notify(`Renamed quest ${from} to ${to} (quests and dialogs updated)`);
    return true;
  } catch (e) {
    const err = e as Error;
    notify(
      err instanceof StorySaveError
        ? `Rename refused, nothing written: ${err.issues.filter((i) => i.severity === "error").slice(0, 2).map((i) => i.message).join("; ")}`
        : `Rename refused: ${err.message}`,
    );
    return false;
  }
}
