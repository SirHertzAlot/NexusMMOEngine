/**
 * One open document for a panel: the draft, dirty, undo and redo, and the
 * save baseline, so a panel stops hand-keeping `saved` strings, undo
 * stacks and `JSON.stringify(x) !== saved`.
 *
 *   const doc = useDocument<FlowDoc>();
 *   doc.load(file);            // opened: clean, no history
 *   doc.edit(next);            // doc.edit(cur => ..., { merge: true }) for a drag
 *   doc.markSaved();           // after the host accepted it
 *   doc.value, doc.dirty, doc.canUndo, doc.undo(), doc.revert()
 *
 * The rules live in `document-state.ts`.
 */

import * as React from "react";
import { docReducer, emptyDoc, type DocState } from "../document-state.js";

export interface DocumentHandle<T> {
  /** The draft; null until loaded. */
  value: T | null;
  /** The copy on disk. */
  saved: T | null;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Undo / Redo as one object, the shape `DocBar` and `useDocActions` take. */
  history: { canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void };
  load: (doc: T) => void;
  edit: (next: T | ((cur: T) => T), opts?: { merge?: boolean }) => void;
  undo: () => void;
  redo: () => void;
  /** The draft (or `doc`) is now the saved copy. */
  markSaved: (doc?: T) => void;
  revert: () => void;
}

export function useDocument<T>(): DocumentHandle<T> {
  const [state, dispatch] = React.useReducer(docReducer as (s: DocState<T>, a: Parameters<typeof docReducer<T>>[1]) => DocState<T>, undefined, () => emptyDoc<T>());
  const api = React.useMemo(
    () => ({
      load: (doc: T) => dispatch({ type: "load", doc }),
      edit: (next: T | ((cur: T) => T), opts?: { merge?: boolean }) => dispatch({ type: "edit", next, merge: opts?.merge }),
      undo: () => dispatch({ type: "undo" }),
      redo: () => dispatch({ type: "redo" }),
      markSaved: (doc?: T) => dispatch({ type: "saved", doc }),
      revert: () => dispatch({ type: "revert" }),
    }),
    [],
  );
  const canUndo = state.past.length > 0;
  const canRedo = state.future.length > 0;
  return {
    value: state.present,
    saved: state.saved,
    dirty: state.dirty,
    canUndo,
    canRedo,
    history: { canUndo, canRedo, undo: api.undo, redo: api.redo },
    ...api,
  };
}
