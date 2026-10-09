/**
 * The left library for Art & audio's Animation, VFX and Audio views: the
 * clips and combat moves, the particle effects, or the audio events of the
 * real documents (the open panel publishes the lists).
 */
import * as React from "react";
import { AUDIO_BUS_NAMES } from "@mmo-engine/art/browser";
import { MIcon } from "./components.js";
import { mediaStore, muted } from "./media-common.js";

function Row({ icon, label, on, trailing, onPick }: { icon: string; label: string; on: boolean; trailing?: string; onPick: () => void }): React.JSX.Element {
  return (
    <li>
      <button
        onClick={onPick} aria-pressed={on}
        className="m3-focus flex h-8 w-full items-center gap-2 rounded-full px-3 font-mono text-xs"
        style={on ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
      >
        <MIcon name={icon} size={15} />
        <span className="truncate">{label}</span>
        {trailing && <span className="ml-auto" style={muted}>{trailing}</span>}
      </button>
    </li>
  );
}

const Group = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider" style={muted}>{children}</p>
);

export function MediaTree({ view }: { view: string }): React.JSX.Element {
  const s = mediaStore.use();
  if (view === "vfx") {
    return (
      <ul className="flex flex-col gap-0.5" aria-label="effects">
        {s.effects.map((e) => <Row key={e} icon="auto_awesome" label={e} on={e === s.effect} onPick={() => mediaStore.set((p) => ({ ...p, effect: e, vfxTab: "effects" }))} />)}
        {s.effects.length === 0 && <li className="px-3 text-xs" style={muted}>loading…</li>}
      </ul>
    );
  }
  if (view === "audio") {
    return (
      <div aria-label="audio events">
        {AUDIO_BUS_NAMES.map((bus) => (
          <div key={bus}>
            <Group>{bus}</Group>
            <ul className="flex flex-col gap-0.5">
              {s.events.filter(([, b]) => b === bus).map(([id]) => <Row key={id} icon="audio_file" label={id} on={id === s.event} onPick={() => mediaStore.set((p) => ({ ...p, event: id }))} />)}
            </ul>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div aria-label="animation library">
      <Group>Combat moves</Group>
      <ul className="flex flex-col gap-0.5">
        {s.moves.map(([id, name]) => <Row key={id} icon="swords" label={name} on={id === s.move && s.animTab === "combat"} trailing={String(id)} onPick={() => mediaStore.set((p) => ({ ...p, move: id, animTab: "combat" }))} />)}
      </ul>
      <Group>Clips</Group>
      <ul className="flex flex-col gap-0.5">
        {s.clips.map((c) => <Row key={c} icon="directions_run" label={c} on={c === s.clip} onPick={() => mediaStore.set((p) => ({ ...p, clip: c, animTab: "clips" }))} />)}
      </ul>
    </div>
  );
}
