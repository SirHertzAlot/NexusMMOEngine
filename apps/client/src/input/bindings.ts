/**
 * Key bindings (U4): keyboard actions remappable, persisted per browser.
 *
 * Each action holds an ordered code list (movement keeps its WASD + arrow
 * pair); rebinding steals a code already used elsewhere, and reset
 * restores the defaults. Mouse attack/block stay fixed: they only fight
 * while the pointer is locked, so rebinding them has no meaning.
 * DOM-free and unit-testable; storage is injected (localStorage in the
 * app, a stub in tests).
 */

export const ACTIONS = [
  "forward",
  "back",
  "left",
  "right",
  "jump",
  "down",
  "flight",
  "dodge",
] as const;

export type ActionId = (typeof ACTIONS)[number];

export const ACTION_LABELS: Record<ActionId, string> = {
  forward: "move forward",
  back: "move back",
  left: "strafe left",
  right: "strafe right",
  jump: "jump / swim up",
  down: "swim / fly down",
  flight: "toggle flight",
  dodge: "dodge",
};

/** Mouse buttons fixed outside rebinding (attack, guard). */
export const FIXED_MOUSE: ReadonlyArray<{ label: string; code: string }> = [
  { label: "attack", code: "Mouse0" },
  { label: "guard (hold)", code: "Mouse2" },
];

export type Bindings = Record<ActionId, string[]>;

export const DEFAULT_BINDINGS: Bindings = {
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  jump: ["Space"],
  down: ["KeyC"],
  flight: ["KeyF"],
  dodge: ["KeyQ"],
};

/** Actions whose press the server acts on (latched until an intent carries them). */
export const PRESS_ACTIONS: readonly ActionId[] = ["jump", "flight", "dodge"];

const STORAGE_KEY = "mmo.bindings.v1";
const MAX_CODES = 4;

function cleanCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const c of value) {
    if (typeof c === "string" && c.length > 0 && c.length <= 32 && !out.includes(c)) out.push(c);
    if (out.length >= MAX_CODES) break;
  }
  return out;
}

/** Parse stored bindings; anything malformed falls back to the defaults. */
export function parseBindings(raw: unknown): Bindings {
  if (typeof raw !== "object" || raw === null) return structuredClone(DEFAULT_BINDINGS);
  const r = raw as Record<string, unknown>;
  const out = structuredClone(DEFAULT_BINDINGS);
  let ok = false;
  for (const a of ACTIONS) {
    const codes = cleanCodes(r[a]);
    if (codes.length > 0) {
      out[a] = codes;
      ok = true;
    }
  }
  return ok ? out : structuredClone(DEFAULT_BINDINGS);
}

export interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function appStorage(): KeyStorage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    // Private mode / blocked storage: settings simply don't persist.
  }
  return null;
}

export function loadBindings(storage: KeyStorage | null = appStorage()): Bindings {
  if (!storage) return structuredClone(DEFAULT_BINDINGS);
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_BINDINGS);
    return parseBindings(JSON.parse(raw) as unknown);
  } catch {
    return structuredClone(DEFAULT_BINDINGS);
  }
}

export function saveBindings(bindings: Bindings, storage: KeyStorage | null = appStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // Persistence is a convenience; the session keeps working.
  }
}

/**
 * Rebind one slot, stealing the code from any other action using it.
 * Mouse codes can't be taken (they're fixed outside rebinding).
 */
export function setBinding(bindings: Bindings, action: ActionId, index: number, code: string): Bindings {
  if (code.startsWith("Mouse")) return bindings;
  const next = structuredClone(bindings);
  for (const a of ACTIONS) {
    if (a !== action) next[a] = next[a].filter((c) => c !== code);
  }
  const slot = Math.max(0, Math.min(index, next[action].length));
  if (slot < next[action].length) next[action][slot] = code;
  else if (next[action].length < MAX_CODES) next[action].push(code);
  return next;
}

export function resetBindings(): Bindings {
  return structuredClone(DEFAULT_BINDINGS);
}

/** Pretty code for the UI ("KeyW" -> "W", "ArrowUp" -> "↑", "Space" stays). */
export function prettyCode(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code === "Space") return "Space";
  const arrows: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };
  return arrows[code] ?? code;
}
