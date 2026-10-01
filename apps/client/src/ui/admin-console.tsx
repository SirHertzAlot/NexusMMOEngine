/**
 * AdminConsole (roadmap A1): the dev client's control over the live
 * world. Sends admin commands (protocol 0x10) and shows results; the
 * server answers 4003 unless the account is an admin. A2+ adds the
 * world-editing commands behind this same box.
 */

import { useState } from "react";
import type { MirrorClient } from "@mmo-engine/mirror";
import { Button, Input } from "./components.js";
import { parseAdminArgs } from "./admin-args.js";

interface Entry {
  command: string;
  ok: boolean;
  message: string;
}

export function AdminConsole({ client }: { client: MirrorClient }): React.ReactElement {
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const run = (): void => {
    const text = command.trim();
    if (!text || busy) return;
    // First word is the command; the rest is its args — a JSON object
    // when it parses as one (`spawn {"what":"tree"}`), else the entity
    // shorthand (`inspect me` sends {entity:"me"}).
    const space = text.search(/\s/);
    const name = (space < 0 ? text : text.slice(0, space)).toLowerCase();
    const rest = space < 0 ? "" : text.slice(space + 1).trim();
    const args = parseAdminArgs(rest);
    setBusy(true);
    client
      .admin(name, args)
      .then((res) => {
        setEntries((prev) => [...prev.slice(-7), { command: text, ok: res.ok, message: res.message }]);
      })
      .catch((err: unknown) => {
        setEntries((prev) => [
          ...prev.slice(-7),
          { command: text, ok: false, message: err instanceof Error ? err.message : String(err) },
        ]);
      })
      .finally(() => {
        setBusy(false);
        setCommand("");
      });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
          placeholder="admin command (help · inspect me)"
          aria-label="admin command: a command, optionally followed by JSON args"
        />
        <Button size="sm" variant="secondary" disabled={busy || command.trim() === ""} onClick={run}>
          run
        </Button>
      </div>
      {entries.map((e, i) => (
        <div key={i} className="whitespace-pre-wrap text-muted-foreground tabular-nums">
          <span className="text-foreground">{e.command}</span>
          {" → "}
          <span className={e.ok ? "text-foreground" : "text-destructive"}>{e.message}</span>
        </div>
      ))}
    </div>
  );
}
