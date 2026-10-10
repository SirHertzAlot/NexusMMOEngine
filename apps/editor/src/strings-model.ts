/**
 * The Strings panel's edit rules (roadmap EA25): pure operations on the
 * string tables (language to id to message), each returning a new set, so
 * the panel's `useDocument` history and these tests see the same thing.
 * The checks themselves (ICU, placeholders, ids) are `validateTables` of
 * @mmo-engine/scene, the same code the dev host refuses a save with.
 */
import { SOURCE_LANG, type StringTables } from "@mmo-engine/scene";

/** `lang`'s message for `id` set to `text`; for a translation, empty text removes it (the id reads "missing"). */
export function setMessage(tables: StringTables, lang: string, id: string, text: string): StringTables {
  const table = { ...(tables[lang] ?? {}) };
  if (text === "" && lang !== SOURCE_LANG) delete table[id];
  else table[id] = text;
  return { ...tables, [lang]: table };
}

/** A new id with its English source; false-y or taken ids change nothing. */
export function addId(tables: StringTables, id: string, text: string): StringTables {
  if (id === "" || id in (tables[SOURCE_LANG] ?? {})) return tables;
  return setMessage(tables, SOURCE_LANG, id, text);
}

/** The id out of every language. */
export function removeId(tables: StringTables, id: string): StringTables {
  const out: StringTables = {};
  for (const [lang, table] of Object.entries(tables)) {
    const { [id]: _gone, ...rest } = table;
    out[lang] = rest;
  }
  return out;
}

/** An empty table for a new language code; an existing one is left alone. */
export function addLang(tables: StringTables, lang: string): StringTables {
  return lang in tables ? tables : { ...tables, [lang]: {} };
}

/** The languages whose table differs from `saved` (a new language counts, even empty): what a save sends. */
export function changedLangs(draft: StringTables, saved: StringTables): StringTables {
  const out: StringTables = {};
  for (const [lang, table] of Object.entries(draft)) {
    if (JSON.stringify(table) !== JSON.stringify(saved[lang])) out[lang] = table;
  }
  return out;
}

/** How much of the English source a language has translated, 0..1 (English itself: 1). */
export function coverage(tables: StringTables, lang: string): number {
  const en = Object.keys(tables[SOURCE_LANG] ?? {});
  if (en.length === 0) return 1;
  const own = tables[lang] ?? {};
  return en.filter((id) => own[id] !== undefined).length / en.length;
}
