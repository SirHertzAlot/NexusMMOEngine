/**
 * Play setup persistence (EA14). The last-used setup (what F5 runs) lives
 * in browser storage; saved, named setups with shortcut keys live in the
 * repo document `content/play/setups.json` through `/api/editor/play/setups`.
 *
 * Pure logic (no React): storage and fetch are injected so node:test can
 * pass fakes. The setup type and its validation are in ../play-setups.ts.
 */

import {
  defaultPlaySetup,
  emptySetups,
  normalizePlaySetup,
  type PlaySetup,
  type PlaySetupsDoc,
} from "../play-setups.js";

export * from "../play-setups.js";

export interface PlayStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memStorage(): PlayStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

let fallbackMem: PlayStorage | null = null;

export function defaultPlayStorage(): PlayStorage {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage as unknown as PlayStorage;
    }
  } catch {
    /* private mode / headless: fall through */
  }
  if (!fallbackMem) fallbackMem = memStorage();
  return fallbackMem;
}

export const LAST_SETUP_KEY = "mmo-editor.play-last";

/** The last-used setup (what F5 / Play runs). */
export function loadLastSetup(storage: PlayStorage = defaultPlayStorage()): PlaySetup {
  try {
    const raw = storage.getItem(LAST_SETUP_KEY);
    if (!raw) return defaultPlaySetup();
    return normalizePlaySetup(JSON.parse(raw) as unknown);
  } catch {
    return defaultPlaySetup();
  }
}

export function saveLastSetup(setup: PlaySetup, storage: PlayStorage = defaultPlayStorage()): void {
  try {
    storage.setItem(LAST_SETUP_KEY, JSON.stringify(setup));
  } catch {
    /* prefs stay in memory */
  }
}

type Fetch = typeof fetch;

/** The saved setups document (an empty one when the file does not exist yet). */
export async function fetchPlaySetups(base = "", f: Fetch = fetch): Promise<PlaySetupsDoc> {
  const res = await f(`${base}/api/editor/play/setups`);
  if (!res.ok) throw new Error(`play setups: HTTP ${res.status}`);
  const body = (await res.json()) as { content?: PlaySetupsDoc };
  return body.content ?? emptySetups();
}

/** Save the whole document; the host refuses an invalid one (every problem listed) and writes nothing. */
export async function savePlaySetups(doc: PlaySetupsDoc, base = "", f: Fetch = fetch): Promise<void> {
  const res = await f(`${base}/api/editor/play/setups`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: doc }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[] };
    throw new Error([b.error ?? `HTTP ${res.status}`, ...(b.issues ?? [])].join("; "));
  }
}

/** Add or replace a named setup (keeping its shortcut unless a new one is given). */
export function withSetup(doc: PlaySetupsDoc, name: string, setup: PlaySetup, shortcut?: string | null): PlaySetupsDoc {
  const old = doc.setups.find((s) => s.name === name);
  const key = shortcut === undefined ? old?.shortcut : (shortcut ?? undefined);
  // A key belongs to one setup: binding it here unbinds it elsewhere.
  const others = doc.setups.filter((s) => s.name !== name).map((s) => (key && s.shortcut === key ? { name: s.name, setup: s.setup } : s));
  const mine = { name, ...(key ? { shortcut: key } : {}), setup: { ...setup } };
  const at = doc.setups.findIndex((s) => s.name === name);
  return { version: 1, setups: at < 0 ? [...others, mine] : [...others.slice(0, at), mine, ...others.slice(at)] };
}

export const withoutSetup = (doc: PlaySetupsDoc, name: string): PlaySetupsDoc => ({
  version: 1,
  setups: doc.setups.filter((s) => s.name !== name),
});
