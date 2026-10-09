/**
 * Shared editor selection model.
 *
 * Every surface that can select an object writes here; inspector panes only
 * read it. Keeping this outside React state lets the viewport, outliner, and
 * entity list stay synchronized without prop-drilling through the shell.
 */

import * as React from "react";

export type SelectionSource = "viewport" | "outliner" | "entity-list";

export interface SelectionField {
  key: string;
  value: string;
}

export interface SelectionComponent {
  name: string;
  fields: readonly SelectionField[];
}

export interface EditorSelection {
  source: SelectionSource;
  kind: string;
  id: string;
  label: string;
  components: readonly SelectionComponent[];
}

type Listener = () => void;

export class EditorSelectionModel {
  private value: EditorSelection | null = null;
  private readonly listeners = new Set<Listener>();

  get(): EditorSelection | null {
    return this.value;
  }

  select(next: EditorSelection): void {
    this.value = next;
    this.listeners.forEach((listener) => listener());
  }

  clear(source?: SelectionSource): void {
    if (this.value === null || (source !== undefined && this.value.source !== source)) return;
    this.value = null;
    this.listeners.forEach((listener) => listener());
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Where a selection belongs. Null = generic (no implied workspace). */
export function inferSelectionLocation(sel: EditorSelection): { workspace: string; view: string } | null {
  if (sel.source === "viewport") return { workspace: "debug", view: "play" };
  if (sel.source === "entity-list" && sel.kind === "entity") return { workspace: "scene", view: "ecs" };
  switch (sel.kind) {
    case "world":
    case "collection":
    case "region":
    case "ecology":
    case "world item":
      return { workspace: "world", view: "terrain" };
    case "scene":
    case "scene-node":
      return { workspace: "scenes", view: "scene" };
    case "dungeon-room":
    case "dungeon-spawn":
    case "dungeon-prop":
    case "room":
    case "spawn":
    case "prop":
      return { workspace: "dungeons", view: "dungeons" };
    case "flow-node":
      return { workspace: "flow", view: "flow" };
    case "graph-node":
      return { workspace: "dungeons", view: "graphs" };
    case "player":
    case "liveops-player":
    case "liveops-scope":
    case "account":
    case "guild":
    case "party":
    case "telemetry":
    case "chat":
    case "ledger":
      return { workspace: "liveops", view: "overview" };
    default:
      return null;
  }
}

/** Whether shell Details should show this selection here (scope stale picks out). */
export function isSelectionVisible(sel: EditorSelection | null, workspace: string, view: string): boolean {
  if (sel === null) return false;
  const loc = inferSelectionLocation(sel);
  if (loc === null) return true;
  return loc.workspace === workspace && loc.view === view;
}

export const editorSelection = new EditorSelectionModel();

export function useEditorSelection(): EditorSelection | null {
  return React.useSyncExternalStore(
    (listener) => editorSelection.subscribe(listener),
    () => editorSelection.get(),
  );
}
