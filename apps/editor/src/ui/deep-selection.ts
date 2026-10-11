/**
 * Deep links: the translation between the URL hash's `sel=` key and the
 * selection stores of the views that have one (scene, dungeon, entity,
 * quest, string, playtest scenario).
 */

import { editorSelection } from "./editor-selection.js";
import { stringsStore } from "./strings-selection.js";
import { selectedQuest, selectedScenario } from "./live-selection.js";

/** Subscribe to every selection store (drives hash sync; one call). */
export function subscribeDeepSelection(fn: () => void): () => void {
  const unsubs = [stringsStore, selectedQuest, selectedScenario, editorSelection].map((s) => s.subscribe(fn));
  return () => unsubs.forEach((u) => u());
}

export function readDeepSelection(workspace: string, view: string): string | null {
  if (workspace === "scenes" && view === "scene") {
    const sel = editorSelection.get();
    if (!sel || !sel.id) return null;
    if (sel.kind === "scene" || sel.kind === "scene-node") return `scene:${sel.id}`;
    return null;
  }
  if (workspace === "dungeons" && view === "dungeons") {
    const sel = editorSelection.get();
    if (!sel || !sel.id) return null;
    if (sel.kind === "dungeon-room") return `dungeon-room:${sel.id}`;
    if (sel.kind === "dungeon-spawn") return `dungeon-spawn:${sel.id}`;
    if (sel.kind === "dungeon-prop") return `dungeon-prop:${sel.id}`;
    return null;
  }
  if (workspace === "scene" && view === "ecs") {
    const sel = editorSelection.get();
    if (sel && sel.kind === "entity" && sel.id) return `entity:${sel.id}`;
    return null;
  }
  switch (`${workspace}/${view}`) {
    case "story/quests": {
      const q = selectedQuest.get();
      return q ? `quest:${q}` : null;
    }
    case "story/strings": {
      const r = stringsStore.get().row;
      return r ? `string:${r}` : null;
    }
    case "release/playtests": {
      const s = selectedScenario.get();
      return s ? `scenario:${s}` : null;
    }
    default:
      return null;
  }
}

/** Apply a deep-selection key; returns the workspace/view it implies. */
export function applyDeepSelection(sel: string): { workspace: string; view: string } | null {
  const i = sel.indexOf(":");
  if (i < 0) return null;
  const kind = sel.slice(0, i);
  const rest = sel.slice(i + 1);
  switch (kind) {
    case "quest":
      if (!rest) return null;
      selectedQuest.set(rest);
      return { workspace: "story", view: "quests" };
    case "string":
      stringsStore.set((p) => ({ ...p, row: rest }));
      return { workspace: "story", view: "strings" };
    case "scenario":
      if (!rest) return null;
      selectedScenario.set(rest);
      return { workspace: "release", view: "playtests" };
    case "scene": {
      if (!rest) return null;
      const slash = rest.indexOf("/");
      const kind = slash >= 0 ? "scene-node" : "scene";
      editorSelection.select({
        source: "outliner",
        kind,
        id: rest,
        label: rest,
        components: [{ name: "Scene", fields: [{ key: "name", value: rest }] }],
      });
      return { workspace: "scenes", view: "scene" };
    }
    case "dungeon-room":
    case "dungeon-spawn":
    case "dungeon-prop": {
      if (!rest) return null;
      const dungeonKind = kind as "dungeon-room" | "dungeon-spawn" | "dungeon-prop";
      editorSelection.select({
        source: "outliner",
        kind: dungeonKind,
        id: rest,
        label: rest,
        components: [{ name: "Dungeon", fields: [{ key: "id", value: rest }] }],
      });
      return { workspace: "dungeons", view: "dungeons" };
    }
    case "entity": {
      if (!rest) return null;
      editorSelection.select({
        source: "entity-list",
        kind: "entity",
        id: rest,
        label: rest,
        components: [],
      });
      return { workspace: "scene", view: "ecs" };
    }
    default:
      return null;
  }
}
