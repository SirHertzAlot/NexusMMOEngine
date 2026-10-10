/**
 * Play setup persistence — what the Play menu chose, and what the
 * play-start path actually honors.
 *
 * Pure logic (no React, no DOM): storage is injected so node:test can
 * pass a fake. The UI defaults to window.localStorage when present.
 *
 * Honored today (passed to serverControl.start / the shell):
 * - where = "viewport" (the embedded game view), "window" (the game view
 *   pops out into a separate window via adoptNode), or "simulate" (world
 *   only, no player client);
 * - clients = "1"/"2"/"4"/"8" (mirror clients; client 0 drives the view,
 *   the rest are headless load);
 * - bots (sent as MMO_BOTS for the owned server);
 * - fresh/keep (world snapshot/restore: fresh backs up world.db on start;
 *   on stop the backup is restored unless keep is set);
 * - from = "World" (default spawn) or "Camera position" (the scene
 *   viewport camera's ground target → MMO_SPAWN_OVERRIDE; "Login" and
 *   "Character creation" need client-side flow execution);
 * - tint (the shell tints tertiary + Details goes read-only while
 *   running).
 *
 * Preview-only (badged "preview" in the menu, never pretended):
 * - from Login / Character creation, net (edge/core switch).
 */

export interface PlaySetup {
  where: string;
  from: string;
  clients: string;
  bots: string;
  net: string;
  latency: string;
  fresh: boolean;
  keep: boolean;
  tint: boolean;
}

export const DEFAULT_PLAY_SETUP: PlaySetup = {
  where: "viewport",
  from: "World",
  clients: "1",
  bots: "10",
  net: "Edge + core",
  latency: "0",
  fresh: true,
  keep: false,
  tint: true,
};

const CLEAN_DEFAULT: PlaySetup = { ...DEFAULT_PLAY_SETUP };

export function defaultPlaySetup(): PlaySetup {
  return { ...CLEAN_DEFAULT };
}

const STR_FIELDS = ["where", "from", "clients", "bots", "net", "latency"] as const;
const BOOL_FIELDS = ["fresh", "keep", "tint"] as const;

/** Validate an unknown value into a PlaySetup (unknown → defaults). */
export function normalizePlaySetup(raw: unknown): PlaySetup {
  const out = defaultPlaySetup();
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  for (const f of STR_FIELDS) {
    if (typeof r[f] === "string" && (r[f] as string).length > 0) {
      (out as unknown as Record<string, string>)[f] = r[f] as string;
    }
  }
  for (const f of BOOL_FIELDS) {
    if (typeof r[f] === "boolean") {
      (out as unknown as Record<string, boolean>)[f] = r[f] as boolean;
    }
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

/** Named setups ("Raid test: 8 clients…"), by name. */
export function loadNamedSetups(storage: PlayStorage = defaultPlayStorage()): Record<string, PlaySetup> {
  try {
    const raw = storage.getItem(NAMED_SETUPS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, PlaySetup> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k.trim() !== "") out[k] = normalizePlaySetup(v);
    }
    return out;
  } catch {
    return {};
  }
}

function writeNamedSetups(all: Record<string, PlaySetup>, storage: PlayStorage): void {
  try {
    storage.setItem(NAMED_SETUPS_KEY, JSON.stringify(all));
  } catch {
    /* prefs stay in memory */
  }
}

export function saveNamedSetup(name: string, setup: PlaySetup, storage: PlayStorage = defaultPlayStorage()): Record<string, PlaySetup> {
  const trimmed = name.trim();
  if (trimmed === "") return loadNamedSetups(storage);
  const all = loadNamedSetups(storage);
  all[trimmed] = { ...setup };
  writeNamedSetups(all, storage);
  return all;
}

export function deleteNamedSetup(name: string, storage: PlayStorage = defaultPlayStorage()): Record<string, PlaySetup> {
  const all = loadNamedSetups(storage);
  delete all[name];
  writeNamedSetups(all, storage);
  return all;
}

/** Bots count the owned server can honor (MMO_BOTS). NaN → 0. */
export function botsCount(setup: PlaySetup): number {
  const n = Number(setup.bots);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * How many mirror clients to connect (1/2/4/8). Invalid → 1.
 * Client 0 drives the game view; the rest are headless load.
 */
export function clientCount(setup: PlaySetup): number {
  const n = Number(setup.clients);
  return n === 1 || n === 2 || n === 4 || n === 8 ? n : 1;
}

/** One-line chip: what Play will do ("In viewport · World · 1 client"). */
export function setupSummary(setup: PlaySetup): string {
  const where = setup.where === "viewport" ? "In viewport" : setup.where === "window" ? "New window" : "Simulate";
  const clients = `${setup.clients} client${setup.clients === "1" ? "" : "s"}`;
  return `${where} · ${setup.from} · ${clients}`;
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

/**
 * Dimensions the start path cannot honor yet (menu badges + leftover
 * report). Keys are setup fields; values explain why.
 */
export const PLAY_PREVIEW_NOTES: Record<string, string> = {
  from: "Login and character creation need the client to run the actual UI flow instead of auto-login",
  net: "No edge/core switch on start; the owned server always runs core",
};
