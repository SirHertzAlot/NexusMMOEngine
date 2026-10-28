/**
 * CastBar — the player's own cast under way (0x1c), as a bar that fills
 * over the cast time, shown under the player frame while casting.
 *
 * The server only says a cast started (with how long it takes) and when
 * it is done or stopped, so the fill is local time since the start.
 */

import { memo, useEffect, useState } from "react";
import type { SpellMessage } from "@mmo-engine/protocol";
import { barFraction } from "./meter.js";
import { spellTitle } from "./spell-notice.js";
import { t } from "../i18n.js";

/** A cast the player started: the spell, when it started (ms, performance.now) and how long it takes. */
export interface CastState {
  spell: string;
  startedAt: number;
  seconds: number;
}

/**
 * The player's cast after a spell message: a cast the player makes that
 * started replaces it, one that is done or stopped clears it, and any
 * other message (someone else's cast) leaves it as it was.
 */
export function nextCast(prev: CastState | null, s: SpellMessage, me: string | null, now: number): CastState | null {
  if (me === null || s.caster !== me) return prev;
  if (s.state === "started") return s.seconds && s.seconds > 0 ? { spell: s.spell, startedAt: now, seconds: s.seconds } : null;
  return null;
}

/** How far the cast is, in [0, 1]. */
export function castFraction(cast: CastState, now: number): number {
  return barFraction((now - cast.startedAt) / 1000, cast.seconds);
}

function CastBarImpl({ cast }: { cast: CastState | null }): React.ReactElement | null {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!cast) return;
    let raf = 0;
    const tick = (): void => {
      setNow(performance.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cast]);
  if (!cast) return null;
  const f = castFraction(cast, now);
  const left = Math.max(0, cast.seconds * (1 - f));
  return (
    <div className="pointer-events-none w-64 rounded-lg border bg-card/90 px-3 py-2 text-card-foreground shadow-sm">
      <div className="mb-0.5 flex justify-between text-[11px] text-muted-foreground">
        <span>{t("cast.casting", { spell: spellTitle(cast.spell) })}</span>
        <span className="tabular-nums">{t("cast.seconds", { value: left.toFixed(1) })}</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded bg-secondary"
        role="progressbar"
        aria-label={t("cast.casting", { spell: spellTitle(cast.spell) })}
        aria-valuenow={Math.round(f * 100)}
        aria-valuemax={100}
      >
        <div className="h-full rounded bg-violet-400" style={{ width: `${f * 100}%` }} />
      </div>
    </div>
  );
}

export const CastBar = memo(CastBarImpl);
CastBar.displayName = "CastBar";
