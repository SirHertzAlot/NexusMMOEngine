/**
 * DocBar: the Undo / Redo / Revert / Save row every document editor shows.
 *
 * A panel passes what its document can do and nothing else; a prop it
 * leaves out (no history, no revert) leaves that button out. Extra buttons
 * (Check, Reload) go in as children, between Revert and Save, so every
 * editor's bar reads the same.
 */

import * as React from "react";
import { Button } from "./components.js";

export interface DocBarProps {
  /** There is something to save or revert. */
  dirty: boolean;
  /** A save or load is in flight: Revert and Save wait. */
  busy?: boolean;
  onSave: () => void;
  /** Absent: no Revert button. */
  onRevert?: () => void;
  /** Revert applies to less than the whole save (one file of several); default `dirty`. */
  canRevert?: boolean;
  /** Absent: no Undo / Redo buttons. */
  history?: { canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void };
  /** Save stays off for another reason (the document has errors). */
  saveBlocked?: boolean;
  /** Default "Save"; e.g. `Save (2)` for the number of files. */
  saveLabel?: string;
  /** Extra buttons between Revert and Save. */
  children?: React.ReactNode;
}

export function DocBar(props: DocBarProps): React.JSX.Element {
  const { dirty, busy = false, history } = props;
  return (
    <div className="flex items-center gap-1.5" role="toolbar" aria-label="Document">
      {history && (
        <>
          <Button size="sm" variant="outline" disabled={!history.canUndo} onClick={history.undo}>Undo</Button>
          <Button size="sm" variant="outline" disabled={!history.canRedo} onClick={history.redo}>Redo</Button>
        </>
      )}
      {props.onRevert && <Button size="sm" variant="ghost" disabled={busy || !(props.canRevert ?? dirty)} onClick={props.onRevert}>Revert</Button>}
      {props.children}
      <Button size="sm" disabled={busy || !dirty || props.saveBlocked} onClick={props.onSave}>{props.saveLabel ?? "Save"}</Button>
    </div>
  );
}
