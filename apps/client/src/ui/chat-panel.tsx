/**
 * ChatPanel (roadmap U6, first slice): region chat over the world.
 *
 * Tabs for the channels that exist (say/yell/emote); whispers (S2) arrive in any tab; guild,
 * guild, and reply need S2–S4 and stay out — the panel says so instead
 * of faking them. Lines arrive through MirrorClient.onChat; sending is
 * fire-and-forget (rejections surface through onError, as everywhere).
 */

import { useEffect, useRef, useState } from "react";
import type { ChatBroadcast, ChatChannel } from "@mmo-engine/protocol";
import { Button, Input } from "./components.js";

const TABS: ChatChannel[] = ["say", "yell", "emote", "party"];

export interface ChatPanelProps {
  lines: ChatBroadcast[];
  channel: ChatChannel;
  onChannel: (c: ChatChannel) => void;
  onSend: (text: string) => void;
}

export function ChatPanel({ lines, channel, onChannel, onSend }: ChatPanelProps): React.ReactElement {
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const shown = lines.filter((l) => l.channel === channel || l.channel === "whisper" || l.channel === "system");
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [shown.length]);
  const send = (): void => {
    if (draft.trim() === "") return;
    onSend(draft);
    setDraft("");
  };
  return (
    <div className="pointer-events-auto absolute bottom-4 left-1/2 flex h-56 w-[26rem] max-w-[90vw] -translate-x-1/2 flex-col rounded-lg border bg-card/90 text-card-foreground shadow-sm">
      <div className="flex gap-1 border-b border-input p-1.5" role="tablist" aria-label="chat channels">
        {TABS.map((t) => (
          <Button
            key={t}
            size="sm"
            variant={t === channel ? "default" : "ghost"}
            role="tab"
            aria-selected={t === channel}
            onClick={() => onChannel(t)}
          >
            {t}
          </Button>
        ))}
        <span className="ml-auto self-center px-1 text-[11px] text-muted-foreground" title="/w name text, /p text, /invite /accept /leave /kick /promote">
          /w /p /invite /leave
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-1 text-sm" aria-live="polite">
        {shown.map((l, i) => (
          <div key={`${l.entity}-${i}`} className="break-words">
            <span className="font-semibold text-foreground">{l.from}</span>
            <span className="text-muted-foreground">{l.channel === "emote" ? " " : ": "}</span>
            <span className="text-foreground">{l.text}</span>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className="flex gap-1.5 p-1.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          placeholder={`say something (${channel})`}
          aria-label="chat message"
          maxLength={500}
        />
        <Button size="sm" variant="secondary" disabled={draft.trim() === ""} onClick={send}>
          send
        </Button>
      </div>
    </div>
  );
}
