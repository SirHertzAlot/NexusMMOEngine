/**
 * The state of one open document: the draft, the last-saved copy, and
 * the undo history between them. Pure, so the rules (what makes it
 * dirty, how a drag merges into one undo step, what Revert and Save
 * do to the history) are tested without a screen; `ui/use-document.ts`
 * wraps it for panels.
 *
 * Dirty is by value (JSON), not identity: editing a field and typing it
 * back leaves the document clean.
 */

export const HISTORY_LIMIT = 200;

export interface DocState<T> {
  /** Null until a document is loaded. */
  present: T | null;
  /** The copy on disk. */
  saved: T | null;
  past: T[];
  future: T[];
  dirty: boolean;
}

export const emptyDoc = <T>(): DocState<T> => ({ present: null, saved: null, past: [], future: [], dirty: false });

export const sameValue = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

export type DocAction<T> =
  /** A document loaded from disk: clean, with no history. */
  | { type: "load"; doc: T }
  /** An edit. `merge` folds it into the previous undo step (one step per drag). */
  | { type: "edit"; next: T | ((cur: T) => T); merge?: boolean }
  | { type: "undo" }
  | { type: "redo" }
  /** The draft (or `doc`) was written to disk. History stays. */
  | { type: "saved"; doc?: T }
  /** Back to the saved copy, as one undoable step. */
  | { type: "revert" };

export function docReducer<T>(state: DocState<T>, action: DocAction<T>): DocState<T> {
  switch (action.type) {
    case "load":
      return { present: action.doc, saved: action.doc, past: [], future: [], dirty: false };
    case "edit": {
      if (state.present === null) return state;
      const next = typeof action.next === "function" ? (action.next as (cur: T) => T)(state.present) : action.next;
      if (next === state.present) return state;
      const past = action.merge && state.past.length > 0 ? state.past : [...state.past.slice(-(HISTORY_LIMIT - 1)), state.present];
      return { ...state, present: next, past, future: [], dirty: !sameValue(next, state.saved) };
    }
    case "undo": {
      if (state.present === null || state.past.length === 0) return state;
      const prev = state.past[state.past.length - 1];
      return { ...state, present: prev, past: state.past.slice(0, -1), future: [...state.future, state.present], dirty: !sameValue(prev, state.saved) };
    }
    case "redo": {
      if (state.present === null || state.future.length === 0) return state;
      const next = state.future[state.future.length - 1];
      return { ...state, present: next, future: state.future.slice(0, -1), past: [...state.past, state.present], dirty: !sameValue(next, state.saved) };
    }
    case "saved": {
      if (state.present === null) return state;
      const doc = action.doc ?? state.present;
      return { ...state, saved: doc, dirty: !sameValue(state.present, doc) };
    }
    case "revert": {
      if (state.present === null || state.saved === null || !state.dirty) return state;
      return { ...state, present: state.saved, past: [...state.past.slice(-(HISTORY_LIMIT - 1)), state.present], future: [], dirty: false };
    }
  }
}
