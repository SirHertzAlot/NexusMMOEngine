/**
 * FriendsFrame (U8) — the friends list with presence, and the block list.
 * Friends are the server's FriendsState (S2b), pushed on login and whenever
 * the list or a friend's presence changes; online friends sort first. Blocks
 * are its BlocksState, folded under a "blocked" toggle. Add by `/friend name`
 * and `/block name`.
 */

import { useState } from "react";
import type { FriendsState } from "@mmo-engine/protocol";
import { Button } from "./components.js";

export interface FriendsFrameProps {
  friends: FriendsState | null;
  /** Names on our block list, in block order. */
  blocked: string[];
  onWhisper(name: string): void;
  onRemove(name: string): void;
  onBlock(name: string): void;
  onUnblock(name: string): void;
}

export function FriendsFrame({ friends, blocked, onWhisper, onRemove, onBlock, onUnblock }: FriendsFrameProps): React.ReactElement | null {
  const [showBlocked, setShowBlocked] = useState(false);
  const list = friends?.friends ?? [];
  if (list.length === 0 && blocked.length === 0) return null;
  const sorted = [...list].sort((a, b) => Number(b.online) - Number(a.online));
  return (
    <div className="absolute bottom-4 left-4 z-10 w-48 rounded-lg border bg-card/90 p-2 text-sm text-card-foreground shadow-sm" aria-label="friends">
      <ul className="space-y-1">
        {sorted.map((f) => (
          <li key={f.name} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${f.online ? "bg-emerald-400" : "bg-muted-foreground/50"}`} title={f.online ? "online" : "offline"} />
            <span className={`truncate ${f.online ? "" : "text-muted-foreground"}`}>{f.name}</span>
            {f.online && (
              <Button size="sm" variant="ghost" className="ml-auto h-5 !px-1" title={`whisper ${f.name}`} onClick={() => onWhisper(f.name)}>
                ✉
              </Button>
            )}
            <Button size="sm" variant="ghost" className={`h-5 !px-1 ${f.online ? "" : "ml-auto"}`} title={`block ${f.name}`} onClick={() => onBlock(f.name)}>
              ⊘
            </Button>
            <Button size="sm" variant="ghost" className="h-5 !px-1" title={`remove ${f.name}`} onClick={() => onRemove(f.name)}>
              ✕
            </Button>
          </li>
        ))}
      </ul>
      {blocked.length > 0 && (
        <div className={list.length > 0 ? "mt-1.5 border-t border-input pt-1.5" : ""}>
          <button
            className="flex w-full items-center text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={showBlocked}
            onClick={() => setShowBlocked((s) => !s)}
          >
            <span className="mr-1">{showBlocked ? "▾" : "▸"}</span>blocked ({blocked.length})
          </button>
          {showBlocked && (
            <ul className="mt-1 space-y-1" aria-label="blocked">
              {blocked.map((n) => (
                <li key={n} className="flex items-center gap-1.5">
                  <span className="truncate text-muted-foreground line-through decoration-muted-foreground/60">{n}</span>
                  <Button size="sm" variant="ghost" className="ml-auto h-5 !px-1 text-xs" title={`unblock ${n}`} onClick={() => onUnblock(n)}>
                    unblock
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
