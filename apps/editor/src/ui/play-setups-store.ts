/**
 * The saved play setups as a shared store: the Play menu edits them, the
 * keyboard handler and the command palette read them. They live in the repo
 * document `content/play/setups.json` (GET/PUT /api/editor/play/setups);
 * browser storage keeps a copy so the menu works before the host answers.
 */

import { createStore } from "../store.js";
import {
  bindSetupShortcut,
  loadSavedSetups,
  persistSavedSetups,
  removeSavedSetup,
  setupsFromDoc,
  setupsToDoc,
  upsertSavedSetup,
  type PlaySetup,
  type SavedPlaySetup,
} from "./play-setup.js";

export const savedSetupsStore = createStore<SavedPlaySetup[]>(loadSavedSetups());
/** Why the last write to the repo document failed (null: it did not). */
export const setupsSaveError = createStore<string | null>(null);

const SETUPS_URL = "/api/editor/play/setups";

async function writeRepo(all: SavedPlaySetup[]): Promise<void> {
  try {
    const res = await fetch(SETUPS_URL, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: setupsToDoc(all) }) });
    const b = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[] };
    setupsSaveError.set(res.ok ? null : [b.error ?? `HTTP ${res.status}`, ...(b.issues ?? [])].join("; "));
  } catch (e) {
    setupsSaveError.set(`could not reach the editor host: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function commit(next: SavedPlaySetup[]): void {
  savedSetupsStore.set(next);
  persistSavedSetups(next);
  void writeRepo(next);
}

/** Load the repo document; when it has none yet, this browser's setups move into it. */
export async function syncSetupsFromRepo(): Promise<void> {
  try {
    const res = await fetch(SETUPS_URL);
    if (!res.ok) return;
    const repo = setupsFromDoc(((await res.json()) as { content?: unknown }).content);
    if (repo.length > 0) {
      savedSetupsStore.set(repo);
      persistSavedSetups(repo);
    } else if (savedSetupsStore.get().length > 0) await writeRepo(savedSetupsStore.get());
  } catch {
    /* no host (tests, a static build): the browser copy stands */
  }
}

if (typeof window !== "undefined") void syncSetupsFromRepo();

export function saveSetupAs(name: string, setup: PlaySetup): void {
  commit(upsertSavedSetup(savedSetupsStore.get(), name, setup));
}

export function deleteSetup(name: string): void {
  commit(removeSavedSetup(savedSetupsStore.get(), name));
}

/** Bind a key; returns why it was refused, or null. */
export function bindSetupKey(name: string, key: string | null): string | null {
  const r = bindSetupShortcut(savedSetupsStore.get(), name, key);
  if (r.error === null) commit(r.all);
  return r.error;
}
