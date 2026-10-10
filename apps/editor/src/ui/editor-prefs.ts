/**
 * Editor preferences, profiles and the stored session (account menu).
 *
 * The editor has no remote account: a "profile" is a named set of local
 * preferences kept in localStorage, and the "session" is what the browser
 * remembers between visits (the active profile, the last workspace you
 * were in and the last play setup). Every read and write is wrapped, so a
 * blocked or full storage leaves the editor on defaults instead of failing.
 */

export interface PrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface EditorPrefs {
  /** Ask the browser to confirm closing the tab while a document has unsaved edits. */
  warnUnsaved: boolean;
  /** Reopen the workspace and view you were last in when the editor loads without a link. */
  restoreLastView: boolean;
}

export const DEFAULT_PREFS: EditorPrefs = { warnUnsaved: true, restoreLastView: false };
export const DEFAULT_PROFILE = "editor";
export const PROFILE_KEY = "mmo-editor.profile";
export const PROFILES_KEY = "mmo-editor.profiles";
export const LAST_VIEW_KEY = "mmo-editor.last-view";
const PLAY_LAST_KEY = "mmo-editor.play-last";
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;

export function browserStorage(): PrefStorage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

const prefsKey = (profile: string): string => `mmo-editor.prefs.${profile}`;

function read(storage: PrefStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: PrefStorage | null, key: string, value: string | null): void {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch {
    /* blocked or full: preferences stay at their defaults */
  }
}

export function currentProfile(storage: PrefStorage | null): string {
  const p = read(storage, PROFILE_KEY);
  return p !== null && PROFILE_NAME.test(p) ? p : DEFAULT_PROFILE;
}

export function listProfiles(storage: PrefStorage | null): string[] {
  let names: string[] = [];
  try {
    const raw = JSON.parse(read(storage, PROFILES_KEY) ?? "[]") as unknown;
    if (Array.isArray(raw)) names = raw.filter((n): n is string => typeof n === "string" && PROFILE_NAME.test(n));
  } catch {
    /* unreadable list: just the default */
  }
  return [...new Set([DEFAULT_PROFILE, currentProfile(storage), ...names])].sort();
}

/** Make `name` the active profile (creating it when new); throws on an invalid name. */
export function switchProfile(storage: PrefStorage | null, name: string): string {
  const n = name.trim().toLowerCase();
  if (!PROFILE_NAME.test(n)) throw new Error("A profile name is 1-24 lowercase letters, digits or dashes, starting with a letter or digit");
  write(storage, PROFILES_KEY, JSON.stringify(listProfiles(storage).concat(n).filter((v, i, a) => a.indexOf(v) === i)));
  write(storage, PROFILE_KEY, n);
  return n;
}

export function loadPrefs(storage: PrefStorage | null, profile = currentProfile(storage)): EditorPrefs {
  const out = { ...DEFAULT_PREFS };
  try {
    const raw = JSON.parse(read(storage, prefsKey(profile)) ?? "{}") as Record<string, unknown>;
    if (typeof raw.warnUnsaved === "boolean") out.warnUnsaved = raw.warnUnsaved;
    if (typeof raw.restoreLastView === "boolean") out.restoreLastView = raw.restoreLastView;
  } catch {
    /* corrupt entry: defaults */
  }
  return out;
}

export function savePrefs(storage: PrefStorage | null, prefs: EditorPrefs, profile = currentProfile(storage)): void {
  write(storage, prefsKey(profile), JSON.stringify(prefs));
}

export function resetPrefs(storage: PrefStorage | null, profile = currentProfile(storage)): void {
  write(storage, prefsKey(profile), null);
}

/** Forget the stored session: the active profile, the last view and the last play setup. Profiles and layouts stay. */
export function signOut(storage: PrefStorage | null): void {
  for (const k of [PROFILE_KEY, LAST_VIEW_KEY, PLAY_LAST_KEY]) write(storage, k, null);
}

export function rememberView(storage: PrefStorage | null, workspace: string, view: string): void {
  write(storage, LAST_VIEW_KEY, JSON.stringify({ workspace, view }));
}

export function recallView(storage: PrefStorage | null): { workspace: string; view: string } | null {
  try {
    const v = JSON.parse(read(storage, LAST_VIEW_KEY) ?? "null") as { workspace?: unknown; view?: unknown } | null;
    return v && typeof v.workspace === "string" && typeof v.view === "string" ? { workspace: v.workspace, view: v.view } : null;
  } catch {
    return null;
  }
}
