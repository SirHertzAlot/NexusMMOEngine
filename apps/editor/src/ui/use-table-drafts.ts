/**
 * Several tables edited side by side, each saved on its own (the rules
 * files, the gameplay grids): one draft per key over `useDocument`, so
 * the panel stops hand-keeping a `drafts` record, a `saved` copy and a
 * `JSON.stringify(a) !== JSON.stringify(b)` per table.
 *
 *   const t = useTableDrafts<Table, unknown>();
 *   t.load(snapshot.tables);        // opened: every table clean
 *   t.edit("items", next);          // t.edit(k, next, { merge: true }) for a drag
 *   t.dirtyOf("items"), t.anyDirty  // by value
 *   t.markSaved("items");           // the host accepted that table
 *   t.revert("items");              // that table only, one undo step
 *   t.undo()                        // undoes the last edit in any table
 */

import * as React from "react";
import { sameValue } from "../document-state.js";
import { useDocument, type DocumentHandle } from "./use-document.js";

export interface TableDrafts<K extends string, V> {
  /** Every table's draft; null until loaded. */
  drafts: Record<K, V> | null;
  /** Every table as last saved. */
  saved: Record<K, V> | null;
  load: (tables: Record<K, V>) => void;
  edit: (key: K, next: V | ((cur: V) => V), opts?: { merge?: boolean }) => void;
  dirtyOf: (key: K) => boolean;
  anyDirty: boolean;
  markSaved: (key: K) => void;
  revert: (key: K) => void;
  history: DocumentHandle<Record<K, V>>["history"];
  undo: () => void;
  redo: () => void;
}

export function useTableDrafts<K extends string, V>(): TableDrafts<K, V> {
  const doc = useDocument<Record<K, V>>();
  const { value: drafts, saved, edit: editDoc, markSaved: markDocSaved } = doc;

  const edit = React.useCallback(
    (key: K, next: V | ((cur: V) => V), opts?: { merge?: boolean }) =>
      editDoc((cur) => ({ ...cur, [key]: typeof next === "function" ? (next as (c: V) => V)(cur[key]) : next }), opts),
    [editDoc],
  );
  const dirtyOf = React.useCallback((key: K): boolean => !!drafts && !!saved && !sameValue(drafts[key], saved[key]), [drafts, saved]);
  const markSaved = React.useCallback(
    (key: K) => {
      if (drafts && saved) markDocSaved({ ...saved, [key]: drafts[key] });
    },
    [drafts, saved, markDocSaved],
  );
  const revert = React.useCallback(
    (key: K) => {
      if (saved) editDoc((cur) => ({ ...cur, [key]: saved[key] }));
    },
    [saved, editDoc],
  );

  return { drafts, saved, load: doc.load, edit, dirtyOf, anyDirty: doc.dirty, markSaved, revert, history: doc.history, undo: doc.undo, redo: doc.redo };
}
