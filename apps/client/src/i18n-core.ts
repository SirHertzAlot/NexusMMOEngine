/**
 * The client's `t()` (roadmap EA25), without the build-time table import so
 * it can be tested: `createT` over the string tables of
 * `content/strings/*.json`. A message missing in the chosen language falls
 * back to English, then to its id (so a gap shows as an id, never blank).
 * The language "pseudo" is the English source accented and stretched.
 */
import { formatMessage, PSEUDO_LANG, SOURCE_LANG, type StringsBundle } from "@mmo-engine/scene";

export type Translate = (id: string, args?: Record<string, unknown>) => string;

/** `?lang=` beats the stored choice, which beats the browser's language; unknown codes fall to English. */
export function pickLang(available: readonly string[], search: string, stored: string | null, browser: readonly string[]): string {
  const ok = (l: string | null | undefined): boolean => !!l && (l === PSEUDO_LANG || available.includes(l));
  const q = new URLSearchParams(search).get("lang");
  if (q && ok(q)) return q;
  if (stored && ok(stored)) return stored;
  for (const b of browser) {
    if (ok(b)) return b;
    const base = b.split("-")[0];
    if (ok(base)) return base;
  }
  return SOURCE_LANG;
}

export function createT(bundles: Record<string, StringsBundle>, lang: string): Translate {
  const en = bundles[SOURCE_LANG]?.messages ?? {};
  const own = lang === PSEUDO_LANG ? en : (bundles[lang]?.messages ?? en);
  const pseudo = lang === PSEUDO_LANG;
  return (id, args = {}) => {
    const msg = own[id] ?? en[id];
    if (msg === undefined) return id;
    try {
      return formatMessage(msg, args, { lang: pseudo ? SOURCE_LANG : lang, pseudo });
    } catch {
      return id;
    }
  };
}
