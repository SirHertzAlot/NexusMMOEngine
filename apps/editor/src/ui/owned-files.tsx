/**
 * Content-browser rows for the files the editor owns (scenes, playtests,
 * build profiles): each can be opened, renamed, duplicated and deleted
 * through the host's whitelisted file routes (files-host.ts). The host
 * refuses a bad name, an existing target, an invalid document or a scene the
 * game flow still uses, and says why; nothing is written then.
 */

import * as React from "react";
import { deleteOwned, duplicateOwned, listOwned, renameOwned, type OwnedKind } from "../files-client.js";
import { TreeItem, notify } from "./components.js";

const SUFFIX: Record<OwnedKind, string> = {
  scene: ".scene.json",
  playtest: ".json",
  build: ".json",
};

export function OwnedFiles({ kind, onOpen }: { kind: OwnedKind; onOpen: (name: string) => void }): React.JSX.Element {
  const [names, setNames] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState("");
  const refresh = React.useCallback(() => {
    listOwned(kind).then(
      (n) => {
        setNames(n);
        setError("");
      },
      (e: Error) => setError(e.message),
    );
  }, [kind]);
  React.useEffect(refresh, [refresh]);

  const attempt = (what: string, fn: () => Promise<string | void>): void => {
    fn().then(
      (msg) => {
        notify(msg ?? what);
        refresh();
      },
      (e: Error) => notify(`${what} refused: ${e.message}`),
    );
  };

  const dim = { color: "var(--m3-on-surface-variant)" } as const;
  if (error) return <p className="px-3 py-1 pl-12 text-xs" style={dim}>Could not read the {kind} files: {error}</p>;
  if (names === null) return <p className="px-3 py-1 pl-12 text-xs" style={dim}>Reading…</p>;
  if (names.length === 0) return <p className="px-3 py-1 pl-12 text-xs" style={dim}>No {kind} files yet.</p>;
  return (
    <>
      {names.map((n) => (
        <TreeItem
          key={n}
          icon="description"
          label={`${n}${SUFFIX[kind]}`}
          depth={1}
          mono
          selected={false}
          onPick={() => onOpen(n)}
          menu={[
            { label: `Open ${n}`, icon: "open_in_new", run: () => onOpen(n) },
            "sep",
            {
              label: "Rename…",
              icon: "edit",
              run: () => {
                const to = window.prompt(`Rename ${kind} "${n}" to (lowercase letters, digits, dashes):`, n);
                if (to && to !== n) attempt(`Renamed ${n} to ${to}`, () => renameOwned(kind, n, to));
              },
            },
            { label: "Duplicate", icon: "content_copy", run: () => attempt("Duplicate", async () => `Created ${await duplicateOwned(kind, n)}`) },
            {
              label: "Delete",
              icon: "delete",
              danger: true,
              run: () => {
                if (window.confirm(`Delete ${n}${SUFFIX[kind]}? This removes the file.`)) attempt(`Deleted ${n}`, () => deleteOwned(kind, n));
              },
            },
          ]}
        />
      ))}
    </>
  );
}
