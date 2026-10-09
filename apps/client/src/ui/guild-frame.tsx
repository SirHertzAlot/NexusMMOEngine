/**
 * GuildFrame (S4): the player's guild. Name and tag, MOTD, roster with rank
 * and presence, and a pending invite to accept. Data is the server's
 * GuildState, pushed on every change. Rank actions follow the server's rules
 * (act on ranks below your own; only the leader hands over leadership); the
 * server stays the judge and refuses the rest.
 */

import { t } from "../i18n.js";
import { useEffect, useRef } from "react";
import type { GuildRank, GuildState } from "@mmo-engine/protocol";

/** The server lapses an invite after 60 s and does not tell the invitee. */
export const GUILD_INVITE_SHOWN_MS = 60_000;

const LADDER: GuildRank[] = ["recruit", "member", "officer", "leader"];
export const rankLevel = (r: GuildRank | null): number => (r === null ? -1 : LADDER.indexOf(r));

/** One step up or down from `r` that `actor` may grant, or null. */
export function nextRank(r: GuildRank, dir: 1 | -1, actor: GuildRank | null): GuildRank | null {
  const to = LADDER[rankLevel(r) + dir];
  if (to === undefined || actor === null) return null;
  if (to === "leader") return actor === "leader" ? to : null;
  return rankLevel(to) < rankLevel(actor) ? to : null;
}

export interface GuildFrameProps {
  guild: GuildState | null;
  self: string | null;
  onAccept(): void;
  onLeave(): void;
  onKick(name: string): void;
  onRank(name: string, rank: GuildRank): void;
  onInviteExpired(): void;
}

export function GuildFrame({ guild, self, onAccept, onLeave, onKick, onRank, onInviteExpired }: GuildFrameProps): React.ReactElement | null {
  const invite = guild?.invite;
  const expired = useRef(onInviteExpired);
  expired.current = onInviteExpired;
  useEffect(() => {
    if (!invite) return;
    const timer = setTimeout(() => expired.current(), GUILD_INVITE_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [invite?.from, invite?.guild]);
  const inGuild = !!guild && guild.name !== "";
  if (!invite && !inGuild) return null;
  const mine = guild?.rank ?? null;
  const myLevel = rankLevel(mine);
  return (
    <div className="space-y-2 text-sm">
      {invite && (
        <div role="alert" className="rounded-lg border bg-card/90 p-2 text-card-foreground shadow-sm">
          <div className="break-words">
            {t("guild.invite", { from: invite.from, guild: invite.guild })}
          </div>
          <button type="button" className="mt-1 text-xs underline" onClick={onAccept}>
            {t("guild.accept")}
          </button>
        </div>
      )}
      {inGuild && guild && (
        <div className="rounded-lg border bg-card/90 p-2 text-card-foreground shadow-sm" aria-label={t("guild.label")}>
          <div className="truncate font-semibold">
            {guild.name} <span className="text-muted-foreground">&lt;{guild.tag}&gt;</span>
          </div>
          {guild.motd && <div className="mb-1 break-words text-xs text-muted-foreground">{guild.motd}</div>}
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {guild.members.map((m) => {
              const up = nextRank(m.rank, 1, mine);
              const down = nextRank(m.rank, -1, mine);
              const canAct = m.name !== self && rankLevel(m.rank) < myLevel;
              return (
                <li key={m.name} className="flex items-center gap-1.5">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${m.online ? "bg-emerald-400" : "bg-muted-foreground/50"}`}
                    title={m.online ? t("social.online") : t("social.offline")}
                  />
                  <span className={`truncate ${m.online ? "" : "text-muted-foreground"}`}>{m.name}</span>
                  <span className="text-xs text-muted-foreground" title={m.rank}>
                    {m.rank === "leader" ? "★" : m.rank === "officer" ? "◆" : ""}
                  </span>
                  {canAct && (
                    <span className="ml-auto flex gap-1">
                      {up && (
                        <button type="button" className="text-xs underline" onClick={() => onRank(m.name, up)} title={t("guild.make", { rank: up })}>
                          {t("guild.up")}
                        </button>
                      )}
                      {down && (
                        <button type="button" className="text-xs underline" onClick={() => onRank(m.name, down)} title={t("guild.make", { rank: down })}>
                          {t("guild.down")}
                        </button>
                      )}
                      {myLevel >= rankLevel("officer") && (
                        <button type="button" className="text-xs underline" onClick={() => onKick(m.name)} title={t("guild.remove")}>
                          {t("guild.kick")}
                        </button>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <button type="button" className="mt-1.5 text-xs underline" onClick={onLeave}>
            {t("guild.leave")}
          </button>
        </div>
      )}
    </div>
  );
}
