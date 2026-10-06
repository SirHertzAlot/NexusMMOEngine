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

export const editorSelection = new EditorSelectionModel();

export function useEditorSelection(): EditorSelection | null {
  return React.useSyncExternalStore(
    (listener) => editorSelection.subscribe(listener),
    () => editorSelection.get(),
  );
}
