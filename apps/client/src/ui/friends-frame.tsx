/**
 * FriendsFrame (U8, first slice) — the friends list with presence. Data is
 * the server's FriendsState (S2b), pushed on login and whenever the list or
 * a friend's presence changes. Online friends sort first; add by `/friend name`.
 */

import type { FriendsState } from "@mmo-engine/protocol";
import { Button } from "./components.js";

export interface FriendsFrameProps {
  friends: FriendsState | null;
  onWhisper(name: string): void;
  onRemove(name: string): void;
}

export function FriendsFrame({ friends, onWhisper, onRemove }: FriendsFrameProps): React.ReactElement | null {
  const list = friends?.friends ?? [];
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => Number(b.online) - Number(a.online));
  return (
    <div className="pointer-events-auto max-h-48 w-48 overflow-y-auto rounded-lg border bg-card/90 p-2 text-sm text-card-foreground shadow-sm" aria-label="friends">
      <ul className="space-y-1">
        {sorted.map((f) => (
          <li key={f.name} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${f.online ? "bg-emerald-400" : "bg-muted-foreground/50"}`} title={f.online ? "online" : "offline"} />
            <span className={`truncate ${f.online ? "" : "text-muted-foreground"}`}>{f.name}</span>
            {f.online && (
              <Button size="sm" variant="ghost" className="ml-auto h-5 px-1" title={`whisper ${f.name}`} onClick={() => onWhisper(f.name)}>
                ✉
              </Button>
            )}
            <Button size="sm" variant="ghost" className={`h-5 px-1 ${f.online ? "" : "ml-auto"}`} title={`remove ${f.name}`} onClick={() => onRemove(f.name)}>
              ✕
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
