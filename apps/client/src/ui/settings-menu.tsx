/**
 * SettingsMenu — the player's way into settings, top right: graphics
 * quality and leaving the world. The full settings screen (controls,
 * audio, UI scale) is docs/ROADMAP.md U4.
 */

import { useState } from "react";
import { Button } from "./components.js";

export function SettingsMenu({
  quality,
  onQuality,
  onDisconnect,
}: {
  /** The quality setting as shown ("auto (high)", "low", ...). */
  quality: string;
  onQuality: () => void;
  onDisconnect: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="absolute right-4 top-4 z-10 flex flex-col items-end gap-2 text-sm">
      <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Settings" title="Settings">
        ⚙ menu
      </Button>
      {open && (
        <div className="flex w-56 flex-col gap-1.5 rounded-md bg-slate-950/85 p-2 shadow backdrop-blur-sm">
          <Button size="sm" variant="secondary" onClick={onQuality} title="Cycle the graphics quality">
            graphics: {quality}
          </Button>
          <Button size="sm" variant="outline" onClick={onDisconnect}>
            leave the world
          </Button>
        </div>
      )}
    </div>
  );
}
