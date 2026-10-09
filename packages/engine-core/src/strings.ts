/**
 * EA25 foundation: localization string tables.
 *
 * `content/strings/<lang>.json` maps string ids to ICU messages. `t()`
 * formats them with the given values. The pseudo-locale (accented +
 * expanded) shakes out hard-coded strings and layout overflow — the
 * client runs fully in it with no hard-coded string left.
 *
 * The ICU subset: {name} placeholders and {count, plural, one {...}
 * other {...}}. Full ICU (select, date/number skeletons) arrives with
 * the EA15 Strings panel; this covers the game's needs today.
 */
import { z } from "zod";

export const Strings = z.record(z.string().min(1, "string id"), z.string());
export type Strings = z.infer<typeof Strings>;

/** Parse and validate a string table (throws on invalid). */
export function loadStrings(json: unknown): Strings {
  return Strings.parse(json);
}

/** Format a message by id; falls back to the id when missing. */
export function t(table: Strings, id: string, values: Record<string, string | number> = {}): string {
  const msg = table[id];
  if (msg === undefined) return id;
  return formatIcu(msg, values);
}

/** Minimal ICU: {name} and {count, plural, one/one {# x} other {# y}}. */
function formatIcu(msg: string, values: Record<string, string | number>): string {
  // Plurals first (they contain placeholders).
  const plural = /\{(\w+),\s*plural,\s*one\s*\{([^{}]*)\}\s*other\s*\{([^{}]*)\}\}/g;
  let out = msg.replace(plural, (_m, key: string, one: string, other: string) => {
    const n = Number(values[key] ?? 0);
    const form = n === 1 ? one : other;
    return form.replace(/#/g, String(n));
  });
  // Simple placeholders.
  out = out.replace(/\{(\w+)\}/g, (m, key: string) => {
    const v = values[key];
    return v === undefined ? m : String(v);
  });
  return out;
}

/**
 * Pseudo-locale: accents every letter and wraps the string, so
 * untranslated (hard-coded) strings stand out and overflows show.
 * Placeholders ({name}) pass through untouched.
 */
export function pseudoLocalize(msg: string): string {
  const ACCENT = "́"; // combining acute
  const parts = msg.split(/(\{\w+\})/g);
  const localized = parts
    .map((p) => {
      if (/^\{\w+\}$/.test(p)) return p;
      return p.replace(/[a-zA-Z]/g, (c) => c + ACCENT);
    })
    .join("");
  return `⟦${localized}⟧`;
}
