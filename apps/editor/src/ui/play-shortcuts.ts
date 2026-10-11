/**
 * Keys that start a saved play setup (EA14). Pure: parse, validate and
 * match; the DOM wiring lives in ui/App.tsx.
 *
 * A key is "Ctrl+Alt+Shift+Meta+<Key>" in that order, <Key> a letter, a
 * digit or F1..F12. Only chords that cannot collide with typing or the
 * editor's own keys are allowed (see validateShortcut).
 */

export interface ChordEvent {
  key: string;
  /** KeyboardEvent.code: the physical key, so Alt+1 is "1" even where Alt+1 types a symbol. */
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

const MODS = ["Ctrl", "Alt", "Shift", "Meta"] as const;
const MOD_ALIASES: Record<string, (typeof MODS)[number]> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
};

function baseKey(raw: string): string | null {
  if (/^[a-z0-9]$/i.test(raw)) return raw.toUpperCase();
  const f = /^f(\d{1,2})$/i.exec(raw);
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 12) return `F${Number(f[1])}`;
  return null;
}

function compose(mods: Set<string>, key: string): string {
  return [...MODS.filter((m) => mods.has(m)), key].join("+");
}

/** Canonical spelling of a typed key ("alt + 1" → "Alt+1"), or null when it is not a key. */
export function normalizeShortcut(text: string): string | null {
  const mods = new Set<string>();
  let key: string | null = null;
  for (const part of text.split("+").map((p) => p.trim())) {
    if (part === "") return null;
    const mod = MOD_ALIASES[part.toLowerCase()];
    if (mod) mods.add(mod);
    else if (key === null) key = baseKey(part);
    else return null;
  }
  return key === null ? null : compose(mods, key);
}

/** The chord a key event is, or null while only modifiers are down. */
export function shortcutFromEvent(e: ChordEvent): string | null {
  const fromCode = /^(?:Digit|Key)([0-9A-Z])$/.exec(e.code ?? "");
  const key = baseKey(fromCode ? fromCode[1]! : e.key);
  if (key === null) return null;
  const mods = new Set<string>();
  if (e.ctrlKey) mods.add("Ctrl");
  if (e.altKey) mods.add("Alt");
  if (e.shiftKey) mods.add("Shift");
  if (e.metaKey) mods.add("Meta");
  return compose(mods, key);
}

/** Keys the editor or the browser own: never bound to a setup. */
const RESERVED = new Set(["F1", "F5", "Shift+F5", "F11", "F12", "Alt+F4", "Ctrl+Shift+S", "Ctrl+Alt+Delete"]);

/** Why a key cannot start a setup, or null when it can. `others` are the setups that already hold keys. */
export function validateShortcut(norm: string, others: ReadonlyArray<{ name: string; shortcut: string | null }>): string | null {
  if (normalizeShortcut(norm) !== norm) return `“${norm}” is not a key`;
  if (RESERVED.has(norm)) return `${norm} is taken by the editor`;
  const parts = norm.split("+");
  const key = parts[parts.length - 1]!;
  const mods = new Set(parts.slice(0, -1));
  const fkey = /^F\d+$/.test(key);
  // Plain letters and digits are typing and tool keys (V/W/E/R); Ctrl alone is paste, save, find.
  if (!fkey && !(mods.has("Alt") || (mods.has("Ctrl") && mods.has("Shift")))) return "Use Alt, or Ctrl+Shift, with a letter or digit (or an F key from F2 to F10)";
  if (mods.has("Meta")) return "The Windows and Command keys are left to the system";
  const clash = others.find((o) => o.shortcut === norm);
  return clash ? `${norm} already starts “${clash.name}”` : null;
}

/** The saved setup whose key this event is, if any. */
export function resolveSetupShortcut<T extends { shortcut: string | null }>(e: ChordEvent, saved: readonly T[]): T | null {
  const chord = shortcutFromEvent(e);
  return chord === null ? null : (saved.find((s) => s.shortcut === chord) ?? null);
}
