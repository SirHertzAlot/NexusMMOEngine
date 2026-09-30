/**
 * AdminConsole (roadmap A1): the dev client's control over the live
 * world. Sends admin commands (protocol 0x10) and shows results; the
 * server answers 4003 unless the account is an admin. A2+ adds the
 * world-editing commands behind this same box.
 */

import { useState } from "react";
import type { MirrorClient } from "@mmo-engine/mirror";
import { Button, Input } from "./components.js";

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
    const name = command.trim().toLowerCase();
    if (!name || busy) return;
    setBusy(true);
    client
      .admin(name)
      .then((res) => {
        setEntries((prev) => [...prev.slice(-7), { command: res.command, ok: res.ok, message: res.message }]);
      })
      .catch((err: unknown) => {
        setEntries((prev) => [
          ...prev.slice(-7),
          { command: name, ok: false, message: err instanceof Error ? err.message : String(err) },
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
          placeholder="admin command (help)"
          aria-label="admin command"
        />
        <Button size="sm" variant="secondary" disabled={busy || command.trim() === ""} onClick={run}>
          run
        </Button>
      </div>
      {entries.map((e, i) => (
        <div key={i} className="text-muted-foreground tabular-nums">
          <span className="text-foreground">{e.command}</span>
          {" → "}
          <span className={e.ok ? "text-foreground" : "text-destructive"}>{e.message}</span>
        </div>
      ))}
    </div>
  );
}
