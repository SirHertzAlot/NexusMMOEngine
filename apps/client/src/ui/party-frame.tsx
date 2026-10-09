/**
 * PartyFrame (U7) — the player's party over the world canvas, and a pending
 * invite to accept. Data is the server's PartyState (S3), pushed on every
 * change; per-member health is not on the wire yet, so a row shows name,
 * leader mark and presence only.
 */

import { t } from "../i18n.js";
import { useEffect, useRef } from "react";
import type { PartyState } from "@mmo-engine/protocol";
import { Button } from "./components.js";

/** The server lapses an invite after 60 s and does not tell the invitee. */
export const INVITE_SHOWN_MS = 60_000;

export interface PartyFrameProps {
  party: PartyState | null;
  /** The viewer's own character name, to tell "leader" from "you can kick". */
  self: string | null;
  onAccept(): void;
  onLeave(): void;
  onKick(name: string): void;
  onPromote(name: string): void;
  /** Hide an invite that has been shown for INVITE_SHOWN_MS. */
  onInviteExpired(): void;
}

export function PartyFrame({ party, self, onAccept, onLeave, onKick, onPromote, onInviteExpired }: PartyFrameProps): React.ReactElement | null {
  const invite = party?.invite;
  // Held in a ref so a parent re-render (every tick) does not restart the timer.
  const expired = useRef(onInviteExpired);
  expired.current = onInviteExpired;
  useEffect(() => {
    if (!invite) return;
    const timer = setTimeout(() => expired.current(), INVITE_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [invite?.from]);
  const members = party?.members ?? [];
  if (!invite && members.length === 0) return null;
  const iAmLeader = members.some((m) => m.leader && m.name === self);
  return (
    <div className="space-y-2 text-sm">
      {invite && (
        <div role="alert" className="rounded-lg border bg-card/90 p-2 text-card-foreground shadow-sm">
          <div className="truncate">
            {t("party.invite", { from: invite.from })}
          </div>
          <Button size="sm" className="mt-1" onClick={onAccept}>
            {t("party.accept")}
          </Button>
        </div>
      )}
      {members.length > 0 && (
        <div className="rounded-lg border bg-card/90 p-2 text-card-foreground shadow-sm" aria-label={t("party.label")}>
          <ul className="space-y-1">
            {members.map((m) => (
              <li key={m.name} className="flex items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${m.online ? "bg-emerald-400" : "bg-muted-foreground/50"}`} title={m.online ? t("social.online") : t("social.offline")} />
                <span className={`truncate ${m.online ? "" : "text-muted-foreground"}`}>{m.name}</span>
                {m.leader && <span title={t("party.leader")}>★</span>}
                {iAmLeader && m.name !== self && (
                  <span className="ml-auto flex gap-1">
                    <button type="button" className="text-xs underline" onClick={() => onPromote(m.name)} title={t("party.make-leader")}>
                      {t("party.lead")}
                    </button>
                    <button type="button" className="text-xs underline" onClick={() => onKick(m.name)} title={t("party.remove")}>
                      {t("party.kick")}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="mt-1.5 text-xs underline" onClick={onLeave}>
            {t("party.leave")}
          </button>
        </div>
      )}
    </div>
  );
}
