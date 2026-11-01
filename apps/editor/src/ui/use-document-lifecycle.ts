/**
 * React binding for the document lifecycle (roadmap M9). A panel gives the
 * hook its open document's actions and gets the File-menu operations and
 * their state back:
 *
 *   const life = useDocumentLifecycle(() => getDocActions(panel));
 *   life.create("scene", "forest-camp");   // new from template
 *   life.load("scene");                    // names of that kind
 *   life.importFile();  life.exportFile(); // shape-checked .json in and out
 *   life.retry();                          // run the failed one again
 *
 * The controller and its rules live in document-lifecycle.ts.
 */

import * as React from "react";
import { createOwned, listOwned, type OwnedKind } from "../files-client.js";
import { exportDocument, importDocument } from "./doc-io.js";
import type { DocActions } from "./doc-actions.js";
import { createDocumentLifecycle, INITIAL_LIFECYCLE, type LifecycleAdapter, type LifecycleState } from "./document-lifecycle.js";

/** The browser adapter: files-client for documents the host owns, doc-io for the open document's file. */
export function browserLifecycleAdapter(getDoc: () => DocActions | null): LifecycleAdapter {
  const doc = (): DocActions => {
    const d = getDoc();
    if (!d) throw new Error("no document is open");
    return d;
  };
  return {
    create: (kind: OwnedKind, name: string) => createOwned(kind, name),
    list: (kind: OwnedKind) => listOwned(kind),
    importFile: () => importDocument(doc()),
    exportFile: async () => exportDocument(doc()),
  };
}

export interface DocumentLifecycleHandle extends LifecycleState {
  create(kind: OwnedKind, name: string): Promise<void>;
  load(kind: OwnedKind): Promise<void>;
  importFile(): Promise<void>;
  exportFile(): Promise<void>;
  retry(): Promise<void>;
}

/** `adapter` must be stable across renders (memoize it, or pass a module-level constant). */
export function useDocumentLifecycle(adapter: LifecycleAdapter): DocumentLifecycleHandle {
  const [state, setState] = React.useState<LifecycleState>(INITIAL_LIFECYCLE);
  const controller = React.useMemo(() => createDocumentLifecycle(adapter, setState), [adapter]);
  return React.useMemo<DocumentLifecycleHandle>(
    () => ({
      ...state,
      create: (kind, name) => controller.run({ type: "new", kind, name }),
      load: (kind) => controller.run({ type: "load", kind }),
      importFile: () => controller.run({ type: "import" }),
      exportFile: () => controller.run({ type: "export" }),
      retry: () => controller.retry(),
    }),
    [state, controller],
  );
}
