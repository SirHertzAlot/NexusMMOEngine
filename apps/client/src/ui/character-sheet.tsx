/**
 * CharacterSheet (roadmap U9, first slice): attributes and derived
 * stats from the stats message (0x0f), with modifier deltas. Skills and
 * their peaks need mastery (M1), injuries need body parts (M2) — the
 * sheet grows those sections when they land instead of faking them.
 */

import type { StatLineMessage } from "@mmo-engine/protocol";

/** Modifier delta text: "+2", "-1", or "" when unmodified. */
export function statDelta(line: StatLineMessage): string {
  const d = Math.round((line.value - line.base) * 100) / 100;
  if (d === 0) return "";
  return d > 0 ? `+${d}` : `${d}`;
}

export function SheetSection({ title, lines }: { title: string; lines: StatLineMessage[] }): React.ReactElement | null {
  if (lines.length === 0) return null;
  return (
    <div>
      <div className="mb-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">{title}</div>
      {lines.map((l) => {
        const delta = statDelta(l);
        return (
          <div key={l.id} className="flex justify-between gap-2 text-sm tabular-nums">
            <span className="text-muted-foreground">{l.name}</span>
            <span className="text-foreground">
              {l.value}
              {delta !== "" && <span className="ml-1 text-xs text-muted-foreground">({delta})</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function CharacterSheet({
  name,
  attributes,
  stats,
}: {
  name: string | null;
  attributes: StatLineMessage[];
  stats: StatLineMessage[];
}): React.ReactElement {
  return (
    <div className="pointer-events-auto w-72 rounded-lg border bg-card/90 p-3 text-card-foreground shadow-sm">
      {name && <div className="mb-1 truncate text-sm font-semibold">{name}</div>}
      <div className="flex flex-col gap-2">
        <SheetSection title="attributes" lines={attributes} />
        <SheetSection title="stats" lines={stats} />
      </div>
    </div>
  );
}
