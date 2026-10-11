/**
 * useMediaDoc: load one animation-side content document through the dev
 * host, edit it in memory, and save it (the host validates again and writes
 * nothing when it refuses). Built on useSaveTask like the other panels.
 */
import * as React from "react";
import { MEDIA_DOCS, type GameContent, type MediaDocName, type MediaIssue } from "@mmo-engine/art/browser";
import { getMedia, saveMedia } from "../media-client.js";
import { useSaveTask, type SaveTask } from "./use-save-task.js";

export interface MediaDoc<N extends MediaDocName> {
  name: N;
  doc: NonNullable<GameContent[N]> | null;
  /** Replace the document (an edit). */
  set: (next: NonNullable<GameContent[N]>) => void;
  dirty: boolean;
  /** The host's issues after a refused save, else the live checks. */
  issues: MediaIssue[];
  loadError: string | null;
  task: SaveTask<MediaIssue>;
  save: () => Promise<boolean>;
  revert: () => void;
}

export function useMediaDoc<N extends MediaDocName>(name: N): MediaDoc<N> {
  type D = NonNullable<GameContent[N]>;
  const [doc, setDoc] = React.useState<D | null>(null);
  const [saved, setSaved] = React.useState("");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const task = useSaveTask<MediaIssue>();

  React.useEffect(() => {
    let live = true;
    getMedia(name).then(
      (d) => {
        if (!live) return;
        setDoc(d);
        setSaved(JSON.stringify(d));
      },
      (e: unknown) => live && setLoadError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [name]);

  const liveIssues = React.useMemo(() => (doc ? MEDIA_DOCS[name].validate(doc) : []), [doc, name]);
  const dirty = doc !== null && JSON.stringify(doc) !== saved;
  const save = React.useCallback(async (): Promise<boolean> => {
    if (!doc) return false;
    const ok = await task.run(() => saveMedia(name, doc), { ok: `saved to content/${MEDIA_DOCS[name].file}` });
    if (ok) setSaved(JSON.stringify(doc));
    return ok;
  }, [doc, name, task]);

  return {
    name,
    doc,
    set: (next) => {
      setDoc(next);
      task.clear();
    },
    dirty,
    issues: task.issues.length > 0 ? task.issues : liveIssues,
    loadError,
    task,
    save,
    revert: () => {
      if (saved) setDoc(JSON.parse(saved) as D);
      task.clear();
    },
  };
}
