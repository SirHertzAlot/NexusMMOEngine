/**
 * The ability bar (roadmap M5, protocol 0x1d): one button per ability the
 * content defines. Pressing one asks the server to trigger it; the server
 * says what happened (casting, queued, fired, interrupted, rejected), and the
 * bar shows the player's own cast and the one press waiting behind it.
 *
 * The server decides cooldowns and the global cooldown. The bar only shows
 * what the server said, so it never guesses when an ability is ready.
 */

import { memo } from "react";
import type { AbilityMessage } from "@mmo-engine/protocol";
import { t, tName } from "../i18n.js";

/** An ability the content defines, as the bar shows it. */
export interface AbilityEntry {
  id: string;
  /** Display name from the content file; the strings table names it otherwise. */
  name?: string;
  /** Hotkey label shown on the button (e.g. "1"); optional. */
  key?: string;
}

/**
 * The bar's abilities from content/combat/abilities.json (served at
 * /content/combat/abilities.json). Entries without a string id are dropped;
 * a file that is not that shape gives an empty bar.
 */
export function abilityEntries(raw: unknown): AbilityEntry[] {
  const list = (raw as { abilities?: unknown } | null)?.abilities;
  if (!Array.isArray(list)) return [];
  const out: AbilityEntry[] = [];
  for (const a of list) {
    const id = (a as { id?: unknown })?.id;
    if (typeof id !== "string" || id.length === 0) continue;
    const name = (a as { name?: unknown }).name;
    out.push(typeof name === "string" && name.length > 0 ? { id, name } : { id });
  }
  return out;
}

/** What the player's own abilities are doing: the one casting and the one queued behind it. */
export interface AbilityBarState {
  casting: string | null;
  queued: string | null;
}

export const NO_ABILITY_STATE: AbilityBarState = { casting: null, queued: null };

/**
 * The bar after an ability message. Only the player's own abilities count:
 * others' casts leave it as it was. A rejected trigger changes nothing here.
 */
export function nextAbilityState(prev: AbilityBarState, m: AbilityMessage, me: string): AbilityBarState {
  if (m.entity !== me) return prev;
  switch (m.state) {
    case "casting":
      return { casting: m.id, queued: prev.queued === m.id ? null : prev.queued };
    case "queued":
      return { ...prev, queued: m.id };
    case "fired":
      return {
        casting: prev.casting === m.id ? null : prev.casting,
        queued: prev.queued === m.id ? null : prev.queued,
      };
    case "interrupted":
      return { casting: prev.casting === m.id ? null : prev.casting, queued: prev.queued };
    case "rejected":
      return prev;
  }
}

function AbilityBarImpl({
  abilities,
  state,
  onUse,
}: {
  abilities: readonly AbilityEntry[];
  state: AbilityBarState;
  onUse: (id: string) => void;
}): React.ReactElement | null {
  if (abilities.length === 0) return null;
  return (
    <div className="pointer-events-auto flex gap-1 rounded-lg border bg-card/90 p-2 text-card-foreground shadow-sm" role="toolbar" aria-label={t("ability.title")}>
      {abilities.map((a) => {
        const casting = state.casting === a.id;
        const queued = state.queued === a.id;
        const name = a.name ?? tName("ability", a.id);
        return (
          <button
            key={a.id}
            type="button"
            className={`relative flex h-14 w-16 flex-col items-center justify-center gap-0.5 overflow-hidden rounded border px-1 text-[11px] hover:bg-accent ${casting ? "border-violet-400 bg-violet-400/20" : ""}`}
            aria-label={name}
            aria-pressed={casting}
            onClick={() => onUse(a.id)}
          >
            {a.key && <span className="absolute left-1 top-0.5 text-[10px] text-muted-foreground">{a.key}</span>}
            <span className="block max-w-full truncate">{name}</span>
            {casting && <span className="text-[10px] text-muted-foreground">{t("ability.casting")}</span>}
            {queued && <span className="text-[10px] text-muted-foreground">{t("ability.queued")}</span>}
          </button>
        );
      })}
    </div>
  );
}

export const AbilityBar = memo(AbilityBarImpl);
AbilityBar.displayName = "AbilityBar";
