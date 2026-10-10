/**
 * Dialogs the menus open: the modal frame, Preferences and Switch profile.
 * Preferences and profiles persist through editor-prefs.ts (localStorage,
 * every access guarded).
 */

import * as React from "react";
import { Button, IconButton, Input, MIcon, notify } from "./components.js";
import {
  DEFAULT_PREFS,
  browserStorage,
  currentProfile,
  listProfiles,
  loadPrefs,
  resetPrefs,
  savePrefs,
  switchProfile,
  type EditorPrefs,
} from "./editor-prefs.js";

export function ShellDialog({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <span className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" style={{ background: "rgba(0,0,0,.4)" }} />
      <div
        className="fixed left-1/2 top-1/3 z-50 w-[26rem] max-w-[90vw] -translate-x-1/2 -translate-y-1/3 rounded-2xl p-5"
        role="dialog"
        aria-label={title}
        style={{ background: "var(--m3-surface-3)", boxShadow: "0 6px 16px rgba(0,0,0,.5)" }}
      >
        <div className="mb-3 flex items-center">
          <p className="text-base font-medium">{title}</p>
          <span className="ml-auto">
            <IconButton label={`Close ${title}`} size={36} onClick={onClose}>
              <MIcon name="close" size={19} />
            </IconButton>
          </span>
        </div>
        {children}
      </div>
    </>
  );
}

const dim = { color: "var(--m3-on-surface-variant)" } as const;

export function PreferencesDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const storage = browserStorage();
  const [prefs, setPrefs] = React.useState<EditorPrefs>(() => loadPrefs(storage));
  const set = (patch: Partial<EditorPrefs>): void => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(storage, next);
  };
  const row = (key: keyof EditorPrefs, label: string, hint: string): React.JSX.Element => (
    <label className="flex items-start gap-3 py-1.5 text-[13px]">
      <input type="checkbox" className="mt-1" checked={prefs[key]} onChange={(e) => set({ [key]: e.target.checked })} />
      <span>
        {label}
        <span className="block text-xs" style={dim}>{hint}</span>
      </span>
    </label>
  );
  return (
    <ShellDialog title="Preferences" onClose={onClose}>
      <p className="mb-2 font-mono text-[11px]" style={dim}>profile: {currentProfile(storage)} · saved in this browser</p>
      {row("warnUnsaved", "Warn before leaving with unsaved changes", "The browser asks before the tab closes or reloads while a document is dirty.")}
      {row("restoreLastView", "Reopen the last workspace on start", "When the editor opens without a link, it returns to where you were.")}
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            resetPrefs(storage);
            setPrefs({ ...DEFAULT_PREFS });
          }}
        >
          Reset to defaults
        </Button>
      </div>
    </ShellDialog>
  );
}

export function ProfileDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const storage = browserStorage();
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState("");
  const current = currentProfile(storage);
  const go = (n: string): void => {
    try {
      const picked = switchProfile(storage, n);
      notify(`Switched to profile ${picked}`);
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <ShellDialog title="Switch profile" onClose={onClose}>
      <p className="mb-2 text-xs" style={dim}>A profile keeps its own preferences. Each is local to this browser.</p>
      <ul className="mb-3 flex flex-col gap-0.5">
        {listProfiles(storage).map((p) => (
          <li key={p}>
            <button
              className="m3-focus flex w-full items-center rounded-lg px-2.5 py-2 text-left text-[13px]"
              aria-current={p === current ? "true" : undefined}
              disabled={p === current}
              onClick={() => go(p)}
            >
              {p}
              {p === current && <span className="ml-auto text-[11px]" style={dim}>current</span>}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Input className="h-9" value={name} placeholder="new profile name" aria-label="New profile name" onChange={(e) => setName(e.target.value)} />
        <Button size="sm" disabled={name.trim() === ""} onClick={() => go(name)}>Create</Button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </ShellDialog>
  );
}
