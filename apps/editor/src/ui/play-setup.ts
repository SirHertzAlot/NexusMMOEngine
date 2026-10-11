/**
 * Play setup: what the Play menu chose, how it is validated, saved by name
 * (with a key that starts it), and what the play-start path honors.
 *
 * Pure logic (no React, no DOM): storage is injected so node:test can
 * pass a fake. The UI defaults to window.localStorage when present.
 *
 * Honored today (passed to serverControl.start / the shell):
 * - where = "viewport" (the embedded game view), "window" (the game view
 *   pops out into a separate window via adoptNode), or "simulate" (world
 *   only, no player client);
 * - clients = 1 to 8 (mirror clients, each with its own seeded account;
 *   client 0 drives the view, the rest are headless load);
 * - bots (sent as MMO_BOTS for the owned server);
 * - latency (a laggy socket on every client);
 * - fresh/keep (world snapshot/restore: fresh backs up world.db on start;
 *   on stop the backup is restored unless keep is set);
 * - from = "World" (default spawn) or "Camera position" (the scene
 *   viewport camera's ground target → MMO_SPAWN_OVERRIDE);
 * - tint (the shell tints tertiary + Details goes read-only while
 *   running).
 *
 * - from = a flow node ("Login", "character-select", ...): the clients open in
 *   the player's client at that node (planLaunch, ui/play-launch.ts);
 * - net = "Edge + core": the host starts the edge beside the core and waits
 *   for its health.
 */

import { latencyMs } from "@mmo-engine/mirror";
import { z } from "zod";
import { normalizeShortcut, validateShortcut } from "./play-shortcuts.js";

export const PLAY_WHERE = ["viewport", "window", "simulate"] as const;
/** The start choices before the flow document is read; the menu lists the flow's own nodes. */
export const PLAY_FROM = ["Login", "Character creation", "World", "Camera position"] as const;
export const CAMERA_FROM = "Camera position";
export const PLAY_NET = ["Core only", "Edge + core"] as const;
export const PLAY_LATENCY = ["0", "80 ms", "200 ms"] as const;
export const MAX_PLAY_CLIENTS = 8;
export const MAX_PLAY_BOTS = 2000;

const intIn = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,5}$/)
    .refine((v) => Number(v) >= min && Number(v) <= max);

/** The one definition of a play setup: every field's allowed values. */
export const playSetupSchema = z.object({
  where: z.enum(PLAY_WHERE),
  /** "World", "Camera position" or a flow node id / title (see fromNodeId). */
  from: z.string().min(1).max(40),
  clients: intIn(1, MAX_PLAY_CLIENTS),
  bots: intIn(0, MAX_PLAY_BOTS),
  net: z.enum(PLAY_NET),
  latency: z.string().regex(/^\d{1,4}( ms)?$/),
  fresh: z.boolean(),
  keep: z.boolean(),
  tint: z.boolean(),
});

export type PlaySetup = z.infer<typeof playSetupSchema>;

export const DEFAULT_PLAY_SETUP: PlaySetup = {
  where: "viewport",
  from: "World",
  clients: "1",
  bots: "10",
  // The owned server is the core; the edge is not started (see netPlan).
  net: "Core only",
  latency: "0",
  fresh: true,
  keep: false,
  tint: true,
};

export function defaultPlaySetup(): PlaySetup {
  return { ...DEFAULT_PLAY_SETUP };
}

/** Validate an unknown value into a PlaySetup: each bad or missing field falls back to its default. */
export function normalizePlaySetup(raw: unknown): PlaySetup {
  const out = defaultPlaySetup();
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  for (const f of Object.keys(playSetupSchema.shape) as Array<keyof PlaySetup>) {
    const ok = playSetupSchema.shape[f].safeParse(r[f]);
    if (ok.success) (out as Record<string, unknown>)[f] = ok.data;
  }
  return out;
}

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
export const NAMED_SETUPS_KEY = "mmo-editor.play-setups";

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

/** A named setup, with the key that starts it (null: none). */
export interface SavedPlaySetup {
  name: string;
  setup: PlaySetup;
  shortcut: string | null;
}

/** Saved setups ("Raid test: 8 clients, 50 bots"), in the order they were first saved. */
export function loadSavedSetups(storage: PlayStorage = defaultPlayStorage()): SavedPlaySetup[] {
  try {
    const raw = storage.getItem(NAMED_SETUPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
    const out: SavedPlaySetup[] = [];
    for (const [name, v] of Object.entries(parsed)) {
      if (name.trim() === "") continue;
      const key = (v as { shortcut?: unknown } | null)?.shortcut;
      const norm = typeof key === "string" ? normalizeShortcut(key) : null;
      // A stored key that fails today's rules or repeats an earlier one is dropped, never run.
      const shortcut = norm !== null && validateShortcut(norm, out) === null ? norm : null;
      out.push({ name, setup: normalizePlaySetup(v), shortcut });
    }
    return out;
  } catch {
    return [];
  }
}

export function persistSavedSetups(all: SavedPlaySetup[], storage: PlayStorage = defaultPlayStorage()): void {
  const rec: Record<string, PlaySetup & { shortcut?: string }> = {};
  for (const s of all) rec[s.name] = { ...s.setup, ...(s.shortcut ? { shortcut: s.shortcut } : {}) };
  try {
    storage.setItem(NAMED_SETUPS_KEY, JSON.stringify(rec));
  } catch {
    /* prefs stay in memory */
  }
}

/** Save (or overwrite) a setup by name, keeping its key. A blank name changes nothing. */
export function upsertSavedSetup(all: SavedPlaySetup[], name: string, setup: PlaySetup): SavedPlaySetup[] {
  const n = name.trim();
  if (n === "") return all;
  if (!all.some((s) => s.name === n)) return [...all, { name: n, setup: { ...setup }, shortcut: null }];
  return all.map((s) => (s.name === n ? { ...s, setup: { ...setup } } : s));
}

export function removeSavedSetup(all: SavedPlaySetup[], name: string): SavedPlaySetup[] {
  return all.filter((s) => s.name !== name);
}

/** Bind (or, with null, clear) a setup's key. The error says why a key was refused. */
export function bindSetupShortcut(all: SavedPlaySetup[], name: string, key: string | null): { all: SavedPlaySetup[]; error: string | null } {
  const rebind = (shortcut: string | null): SavedPlaySetup[] => all.map((s) => (s.name === name ? { ...s, shortcut } : s));
  if (key === null) return { all: rebind(null), error: null };
  const norm = normalizeShortcut(key);
  if (norm === null) return { all, error: `“${key}” is not a key` };
  const error = validateShortcut(norm, all.filter((s) => s.name !== name));
  return error ? { all, error } : { all: rebind(norm), error: null };
}

/** Bots count the owned server can honor (MMO_BOTS). NaN → 0. */
export function botsCount(setup: PlaySetup): number {
  const n = Number(setup.bots);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * How many mirror clients to connect (1 to 8). Invalid → 1.
 * Client 0 drives the game view; the rest are headless load.
 */
export function clientCount(setup: PlaySetup): number {
  const n = Number(setup.clients);
  return Number.isInteger(n) && n >= 1 && n <= MAX_PLAY_CLIENTS ? n : 1;
}

/** One-line chip: what Play will do ("In viewport · World · 1 client"). */
export function setupSummary(setup: PlaySetup): string {
  const where = setup.where === "viewport" ? "In viewport" : setup.where === "window" ? "New window" : "Simulate";
  const clients = `${setup.clients} client${setup.clients === "1" ? "" : "s"}`;
  return `${where} · ${setup.from} · ${clients}`;
}

/** The longer line for a saved setup ("8 clients · 50 bots · 80 ms"). */
export function setupDetail(setup: PlaySetup): string {
  const parts = [`${setup.clients} client${setup.clients === "1" ? "" : "s"}`, `${setup.bots} bots`];
  const lag = latencyMs(setup.latency);
  if (lag > 0) parts.push(`${lag} ms`);
  if (setup.where !== "viewport") parts.push(setup.where === "window" ? "new window" : "simulate");
  return parts.join(" · ");
}

/**
 * Whether the start path should connect a mirror client (player view).
 * Simulate mode runs the world with no player: the server ticks, the
 * editor shows status, no game view opens.
 */
export function shouldConnectPlayer(setup: PlaySetup): boolean {
  return setup.where !== "simulate";
}

/** Status label for the play mode panel. */
export function simulateLabel(setup: PlaySetup): string {
  return setup.where === "simulate" ? "Simulate — world only, no player" : setupSummary(setup);
}

/** Whether the run starts the edge beside the core ("Edge + core"). */
export const useEdge = (setup: PlaySetup): boolean => setup.net === "Edge + core";

/** The flow node id a "Start node" choice names ("Character creation" is "character-creation"; the camera starts in the world). */
export function fromNodeId(from: string): string {
  return from === CAMERA_FROM ? "world" : from.trim().toLowerCase().replace(/\s+/g, "-");
}

/** The saved setups as the repo document `content/play/setups.json` (play-host.ts validates it). */
export function setupsToDoc(all: SavedPlaySetup[]): { version: 1; setups: Array<{ name: string; shortcut?: string; setup: PlaySetup }> } {
  return { version: 1, setups: all.map((s) => ({ name: s.name, ...(s.shortcut ? { shortcut: s.shortcut } : {}), setup: s.setup })) };
}

/** Read the repo document back; entries that fail today's rules are dropped, never run. */
export function setupsFromDoc(doc: unknown): SavedPlaySetup[] {
  const list = (doc as { setups?: unknown } | null)?.setups;
  if (!Array.isArray(list)) return [];
  const out: SavedPlaySetup[] = [];
  for (const e of list as Array<{ name?: unknown; shortcut?: unknown; setup?: unknown }>) {
    if (typeof e?.name !== "string" || e.name.trim() === "" || out.some((o) => o.name === e.name)) continue;
    const norm = typeof e.shortcut === "string" ? normalizeShortcut(e.shortcut) : null;
    out.push({ name: e.name, setup: normalizePlaySetup(e.setup), shortcut: norm !== null && validateShortcut(norm, out) === null ? norm : null });
  }
  return out;
}
