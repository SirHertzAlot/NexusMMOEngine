/**
 * What the character screen offers (roadmap EB7).
 *
 * The categories and swatches used to be two constants in
 * character-screen.tsx, which the server mirrored in a denylist of its
 * own: a game that changed one had to find the other. Both now come from
 * `content/character-creation.json`, the file the server validates
 * against and the editor edits, fetched the same way the client already
 * fetches its other content.
 *
 * No file is the normal case and means the engine's defaults, so the
 * screen never waits on this: it renders the defaults and swaps them if
 * a game's file comes back.
 */

import {
  DEFAULT_CREATION_RULES,
  parseCreationRules,
  type CreationRules,
} from "@mmo-engine/art/browser";

export const CREATION_RULES_URL = "/content/character-creation.json";

/**
 * The game's creation rules, or the engine's defaults. Never rejects:
 * no file, an unreachable server and a file the engine would refuse all
 * end in the defaults, because a character screen that cannot draw is
 * worse than one drawing the engine's own choices. A refused file is
 * logged, since someone wrote it on purpose.
 */
export async function fetchCreationRules(fetcher: typeof fetch = fetch, url = CREATION_RULES_URL): Promise<CreationRules> {
  let raw: unknown;
  try {
    const res = await fetcher(url);
    if (!res.ok) return DEFAULT_CREATION_RULES;
    raw = await res.json();
  } catch {
    return DEFAULT_CREATION_RULES;
  }
  const parsed = parseCreationRules(raw);
  if ("rules" in parsed) return parsed.rules;
  console.warn(`[character] ${url} is not usable, using the engine's defaults:`, parsed.problems.map((p) => `${p.path || "(root)"}: ${p.message}`).join("; "));
  return DEFAULT_CREATION_RULES;
}

/**
 * A slot's label when the strings table has none — a game that offers a
 * slot the engine's own screen never did ("helmet") should read as
 * "Helmet", not as the id of a string nobody wrote.
 */
export function slotLabel(id: string, translated: string): string {
  if (translated !== id) return translated;
  const last = id.split(".").pop() ?? id;
  const words = last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
