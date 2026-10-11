/**
 * The Animation view's left library and right Details: both read what the
 * open Animation panel published to animationStore (the rig's real clips,
 * the combat moves, the facts of the current selection).
 */
import * as React from "react";
import { SelectableList } from "./selectable-list.js";
import { SectionLabel } from "./widgets.js";
import { animationStore } from "./animation-store.js";

const dim = { color: "var(--m3-on-surface-variant)" } as const;

/** The rig's clips (or the ones the graph and the moves play) and the combat moves. */
export function ClipList(): React.JSX.Element {
  const { clip, move, clips, moves } = animationStore.use();
  return (
    <div>
      <SelectableList
        mono
        items={clips}
        itemKey={(c) => c}
        label={(c) => c}
        icon="directions_run"
        selected={clip}
        onPick={(c) => animationStore.set((p) => ({ ...p, clip: c, tab: "clips" }))}
      />
      {clips.length === 0 && <p className="px-2 text-xs" style={dim}>Open the Animation view to load the clips.</p>}
      <SectionLabel>Combat moves</SectionLabel>
      <SelectableList
        mono
        items={moves}
        itemKey={([id]) => String(id)}
        label={([, name]) => name}
        tag={([id]) => String(id)}
        icon="swords"
        selected={moves.some(([id]) => id === move) ? String(move) : undefined}
        onPick={([id]) => animationStore.set((p) => ({ ...p, move: id, tab: "combat" }))}
      />
    </div>
  );
}

/** The facts of the selection the open view published (a clip, a locomotion state, a combat move). */
export function AnimDetails(): React.JSX.Element {
  const { detail } = animationStore.use();
  return (
    <div className="flex flex-col gap-2" data-details="animation">
      <p className="font-mono text-xs" style={dim}>ANIMATION</p>
      {detail.title ? (
        <p className="text-sm font-semibold">{detail.title}</p>
      ) : (
        <p className="text-sm" style={dim}>Pick a clip, a locomotion state or a combat move to see its details.</p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        {detail.rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt style={dim}>{k}</dt>
            <dd className="font-mono">{v}</dd>
          </React.Fragment>
        ))}
      </dl>
      {detail.note && <p className="text-[11px]" style={dim}>{detail.note}</p>}
    </div>
  );
}
