/**
 * `t(id, values)`: every player-facing string of the client goes through it
 * (roadmap EA25). The tables are `content/strings/<lang>.json`, the ICU
 * formatting, fallbacks and the pseudo-locale are the shared code in
 * @mmo-engine/scene (the editor's Strings panel uses the same). main.tsx
 * calls `initI18n` with the inlined tables before the first render; tests
 * call it with `en.json`. Until then `t` answers the id, so a missed init
 * shows as ids, never as blank text.
 *
 * The language is `?lang=` (try `?lang=pseudo`), the stored choice
 * (`localStorage mmo.lang`, set by the settings menu) or the browser's.
 */
import { pickLang, translator, PSEUDO_LANG, SOURCE_LANG, type StringTables, type Translate } from "@mmo-engine/scene";

const LANG_KEY = "mmo.lang";
let current: Translate = (id) => id;
let available: string[] = [SOURCE_LANG];
export let lang: string = SOURCE_LANG;

/** `t` is stable: it follows whatever `initI18n` last set. */
export const t: Translate = (id, values) => current(id, values);

function stored(): string | null {
  try {
    return globalThis.localStorage?.getItem(LANG_KEY) ?? null;
  } catch {
    return null;
  }
}

export function initI18n(tables: StringTables, search = "", browser: readonly string[] = []): void {
  available = Object.keys(tables);
  lang = pickLang(available, search, stored(), browser);
  current = translator(tables, lang);
}

/** The languages the settings menu offers (the source first; the pseudo-locale is the editor's and `?lang=pseudo`). */
export const languages = (): string[] => available.filter((l) => l !== PSEUDO_LANG);

/** A language's own name ("Deutsch"), from the browser's locale data. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function storeLang(code: string): void {
  try {
    globalThis.localStorage?.setItem(LANG_KEY, code);
  } catch {
    /* private mode: the choice lasts until reload only through ?lang= */
  }
}

/** A name from game data ("power", "head"): its `<prefix>.<key>` string when the tables have one, else the key itself. */
export function tName(prefix: string, key: string): string {
  const id = `${prefix}.${key}`;
  const s = current(id);
  return s === id ? key : s;
}
