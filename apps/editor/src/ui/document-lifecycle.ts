/**
 * The File-menu lifecycle of a document panel, as one controller (roadmap
 * M9: new, import, export, load, retry). The controller owns the busy and
 * error state and remembers the last operation, so a failed one can be run
 * again with `retry`. It has no React and no DOM: the caller supplies the
 * I/O through a `LifecycleAdapter`, so node:test covers every path.
 *
 *   new     → the host creates a document from its template (createOwned)
 *   load    → the host's list of documents of a kind (listOwned)
 *   import  → the panel's file picker and shape-checked import (doc-io)
 *   export  → the open document downloaded as .json (doc-io)
 *   retry   → run the failed operation again
 */

import type { OwnedKind } from "../files-client.js";

export type LifecycleOp =
  | { type: "new"; kind: OwnedKind; name: string }
  | { type: "load"; kind: OwnedKind }
  | { type: "import" }
  | { type: "export" };

export interface LifecycleAdapter {
  create(kind: OwnedKind, name: string): Promise<void>;
  list(kind: OwnedKind): Promise<string[]>;
  /** Pick and import a file; resolves to its name, or null when the picker is dismissed. */
  importFile(): Promise<string | null>;
  /** Download the open document; resolves to the file name written. */
  exportFile(): Promise<string>;
}

export interface LifecycleState {
  /** The operation running now, if any. */
  busy: LifecycleOp["type"] | null;
  /** The last failure's message, cleared when the next operation starts. */
  error: string | null;
  /** Document names by kind, from the last `load` (or a `new`, which reloads its kind). */
  names: Partial<Record<OwnedKind, string[]>>;
  /** The file the last import or export touched. */
  lastFile: string | null;
  /** The operation that ran last, the one `retry` runs again after a failure. */
  lastOp: LifecycleOp | null;
}

export const INITIAL_LIFECYCLE: LifecycleState = { busy: null, error: null, names: {}, lastFile: null, lastOp: null };

export interface DocumentLifecycle {
  readonly state: LifecycleState;
  run(op: LifecycleOp): Promise<void>;
  /** Run the failed operation again; a no-op when the last one succeeded or none ran. */
  retry(): Promise<void>;
}

export function createDocumentLifecycle(adapter: LifecycleAdapter, onChange: (s: LifecycleState) => void = () => {}): DocumentLifecycle {
  let state: LifecycleState = INITIAL_LIFECYCLE;
  const set = (patch: Partial<LifecycleState>): void => {
    state = { ...state, ...patch };
    onChange(state);
  };

  async function run(op: LifecycleOp): Promise<void> {
    set({ busy: op.type, error: null, lastOp: op });
    try {
      switch (op.type) {
        case "new": {
          const name = op.name.trim();
          if (name === "") throw new Error("a document needs a name");
          await adapter.create(op.kind, name);
          set({ names: { ...state.names, [op.kind]: await adapter.list(op.kind) } });
          break;
        }
        case "load":
          set({ names: { ...state.names, [op.kind]: await adapter.list(op.kind) } });
          break;
        case "import": {
          const file = await adapter.importFile();
          if (file !== null) set({ lastFile: file });
          break;
        }
        case "export":
          set({ lastFile: await adapter.exportFile() });
          break;
      }
      set({ busy: null });
    } catch (e) {
      set({ busy: null, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    get state() {
      return state;
    },
    run,
    async retry() {
      if (state.error === null || state.lastOp === null) return;
      await run(state.lastOp);
    },
  };
}
