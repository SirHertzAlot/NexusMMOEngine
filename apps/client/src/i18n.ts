/**
 * `t(id, args)`: every player-facing string of the client goes through it
 * (roadmap EA25). The tables are `content/strings/<lang>.json`; main.tsx
 * hands them to `initI18n` (they are inlined by vite-game-ui.ts) before the
 * first render, and tests hand it the same files. The language is `?lang=`
 * (try `?lang=pseudo`), the stored choice (`localStorage mmo.lang`) or the
 * browser's. Until initialised, `t` answers the id.
 */
import type { StringsBundle } from "@mmo-engine/scene";
import { createT, pickLang, type Translate } from "./i18n-core.js";

let current: Translate = (id) => id;
export let lang = "en";

/** `t` is stable: it follows whatever `initI18n` last set. */
export const t: Translate = (id, args) => current(id, args);

function stored(): string | null {
  try {
    return globalThis.localStorage?.getItem("mmo.lang") ?? null;
  } catch {
    return null;
  }
}

export function initI18n(bundles: Record<string, StringsBundle>, search = "", browser: readonly string[] = []): void {
  lang = pickLang(Object.keys(bundles), search, stored(), browser);
  current = createT(bundles, lang);
}
