/**
 * The status frame (roadmap M5, protocol 0x1f): the buffs and debuffs on the
 * player, with stack counts. The server says when one is applied or removed;
 * this frame keeps the list for the player's own entity only.
 */

import { memo } from "react";
import type { StatusMessage } from "@mmo-engine/protocol";
import { t, tName } from "../i18n.js";

/** One status the player carries. */
export interface StatusView {
  id: string;
  stacks: number;
}

/**
 * The player's statuses after a status message. Applied replaces the entry
 * for that id (a refresh or another stack) or adds it; removed takes it off.
 * Statuses on other entities leave the list as it was.
 */
export function nextStatuses(prev: readonly StatusView[], m: StatusMessage, me: string): StatusView[] {
  if (m.entity !== me) return [...prev];
  if (m.state === "removed") return prev.filter((s) => s.id !== m.id);
  const stacks = Math.max(1, m.stacks ?? 1);
  const i = prev.findIndex((s) => s.id === m.id);
  if (i < 0) return [...prev, { id: m.id, stacks }];
  const next = [...prev];
  next[i] = { id: m.id, stacks };
  return next;
}

function StatusFrameImpl({ statuses }: { statuses: readonly StatusView[] }): React.ReactElement | null {
  if (statuses.length === 0) return null;
  return (
    <div className="pointer-events-none w-64 rounded-lg border bg-card/90 p-2 text-card-foreground shadow-sm" role="list" aria-label={t("status.title")}>
      <div className="mb-1 text-[11px] text-muted-foreground">{t("status.title")}</div>
      <div className="flex flex-wrap gap-1">
        {statuses.map((s) => (
          <span key={s.id} role="listitem" className="rounded border px-1.5 py-0.5 text-xs">
            {tName("status", s.id)}
            {s.stacks > 1 && <span className="ml-1 tabular-nums text-muted-foreground">{t("status.stacks", { count: s.stacks })}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

export const StatusFrame = memo(StatusFrameImpl);
StatusFrame.displayName = "StatusFrame";
