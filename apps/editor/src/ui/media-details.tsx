/**
 * The Details pane for Art & audio's Animation, VFX and Audio views: the
 * open panel publishes what it has selected (a state, a move, an effect, an
 * event) with facts read from the real documents.
 */
import * as React from "react";
import { createStore } from "./previews.js";
import { muted } from "./media-common.js";

export interface Detail {
  title: string;
  rows: Array<[string, string]>;
  note?: string;
}

export const detailStore = createStore<Detail>({ title: "", rows: [], note: undefined });

export function MediaDetails({ view }: { view: string }): React.JSX.Element {
  const d = detailStore.use();
  return (
    <div className="flex flex-col gap-2" data-details={view}>
      <p className="font-mono text-xs" style={muted}>{view.toUpperCase()}</p>
      {d.title ? <p className="text-sm font-semibold">{d.title}</p> : <p className="text-sm" style={muted}>Open the {view} view to see its selection.</p>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        {d.rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt style={muted}>{k}</dt>
            <dd className="font-mono">{v}</dd>
          </React.Fragment>
        ))}
      </dl>
      {d.note && <p className="text-[11px]" style={muted}>{d.note}</p>}
    </div>
  );
}
