/**
 * The duel window (roadmap M5, protocol 0x20): a challenge arrives as an accept or
 * decline choice, a challenge the player sent waits, and an accepted duel offers
 * yield. The server owns the duel: this panel only shows what the server said
 * and sends the player's choice back. With no duel, a challenge button targets
 * the player's current target.
 */

import type { DuelMessage } from "@mmo-engine/protocol";
import { t } from "../i18n.js";

export type DuelView = { phase: "incoming" | "outgoing" | "active"; a: string; b: string };

/**
 * The duel after a duel message, seen from `me` (the player's wire id). Events
 * for other players leave it as it was. A duel that started, was accepted or
 * was challenged puts the pair in view; a declined, expired or ended duel clears it.
 */
export function nextDuel(prev: DuelView | null, m: DuelMessage, me: string): DuelView | null {
  const involved = m.a === me || m.b === me;
  if (!involved) return prev;
  switch (m.state) {
    case "challenged":
      return m.b === me ? { phase: "incoming", a: m.a, b: m.b } : { phase: "outgoing", a: m.a, b: m.b };
    case "accepted":
    case "started":
      return { phase: "active", a: m.a, b: m.b };
    case "declined":
    case "expired":
    case "ended":
      return null;
  }
}

/** The other player in a duel, as a wire id. */
export function duelOpponent(d: DuelView, me: string): string {
  return d.a === me ? d.b : d.a;
}

export function DuelPanel({
  duel,
  target,
  onChallenge,
  onAccept,
  onDecline,
  onYield,
}: {
  duel: DuelView | null;
  /** The player's current target (a player or a creature), for the challenge button. */
  target: { name: string } | null;
  onChallenge: () => void;
  onAccept: () => void;
  onDecline: () => void;
  onYield: () => void;
}): React.ReactElement | null {
  if (duel === null) {
    if (target === null) return null;
    return (
      <div className="pointer-events-auto rounded-lg border bg-card/90 p-2 text-card-foreground shadow-sm">
        <button type="button" className="rounded border px-2 py-1 text-xs hover:bg-accent" onClick={onChallenge}>
          {t("duel.challenge", { name: target.name })}
        </button>
      </div>
    );
  }
  return (
    <div className="pointer-events-auto w-64 rounded-lg border bg-card/90 p-3 text-card-foreground shadow-sm" role="region" aria-label={t("duel.title")}>
      <div className="mb-2 text-sm font-semibold">{t("duel.title")}</div>
      {duel.phase === "incoming" && (
        <div className="flex gap-2">
          <button type="button" className="rounded border px-2 py-1 text-xs hover:bg-accent" onClick={onAccept}>
            {t("duel.accept")}
          </button>
          <button type="button" className="rounded border px-2 py-1 text-xs hover:bg-accent" onClick={onDecline}>
            {t("duel.decline")}
          </button>
        </div>
      )}
      {duel.phase === "outgoing" && <div className="text-xs text-muted-foreground">{t("duel.waiting")}</div>}
      {duel.phase === "active" && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{t("duel.active")}</span>
          <button type="button" className="rounded border px-2 py-1 text-xs hover:bg-accent" onClick={onYield}>
            {t("duel.yield")}
          </button>
        </div>
      )}
    </div>
  );
}
