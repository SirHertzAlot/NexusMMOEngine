/**
 * Mockup-faithful preview panes for workspaces whose modules have not
 * landed yet (UI-ONLY).
 *
 * Each preview mirrors its concept mockup in docs/editor-update-refs
 * (ux-08..ux-19) with static sample data and is badged with the EA
 * slice that will own it. Nothing here reads or writes engine state;
 * when a slice lands, its panel replaces the preview one-for-one.
 */

import * as React from "react";
import { MIcon, TreeItem, OverflowMenu, IconButton, notify, staged } from "./components.js";
import type { MenuItem } from "./components.js";

// ---------------------------------------------------------------- shared UI state
// Doc §3.1: selection is a shared model, not panel state — picking in any
// view feeds every inspector. These tiny external stores are the shell's
// UI-only version of that: selection + local drafts. Nothing here touches
// the simulation; backend slices replace the sample data one-for-one.

interface Listener {
  (): void;
}

function createStore<T>(initial: T): {
  get: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  subscribe: (fn: () => void) => () => void;
  use: () => T;
} {
  let value = initial;
  const listeners = new Set<Listener>();
  const subscribe = (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };
  return {
    get: () => value,
    set: (next) => {
      value = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      listeners.forEach((l) => l());
    },
    subscribe,
    use: () => React.useSyncExternalStore(subscribe, () => value),
  };
}

/** Subscribe to every selection store (drives hash sync; one call). */
export function subscribeDeepSelection(fn: () => void): () => void {
  const unsubs = [dbStore, storyStore, stringsStore, liveOpsStore, artStore, hudStore, releaseStore, flowStore].map((s) => s.subscribe(fn));
  return () => unsubs.forEach((u) => u());
}

/** M3 outlined field with local draft editing: type, Enter commits, Esc reverts. */
export function DraftField({ label, value, onCommit, mono = true, wide = false }: {
  label: string;
  value: string;
  onCommit?: (next: string) => void;
  mono?: boolean;
  wide?: boolean;
}): React.JSX.Element {
  const [text, setText] = React.useState(value);
  const [dirty, setDirty] = React.useState(false);
  React.useEffect(() => {
    setText(value);
    setDirty(false);
  }, [value]);
  const commit = (): void => {
    if (text !== value) {
      onCommit?.(text);
      setDirty(true);
    }
  };
  return (
    <div
      className={`relative rounded-md px-3.5 pb-1.5 pt-4 ${wide ? "col-span-full" : ""}`}
      style={{ border: dirty ? "2px solid var(--m3-tertiary)" : "1px solid var(--m3-outline)" }}
      title={dirty ? "Edited locally — staged as a draft, not yet sent" : "Click to edit (local draft)"}
    >
      <small
        className="absolute flex items-center gap-1 px-1 text-xs"
        style={{ top: -9, left: 10, background: "var(--m3-surface-1)", color: dirty ? "var(--m3-tertiary)" : "var(--m3-on-surface-variant)" }}
      >
        {label}{dirty ? " ●" : ""}
      </small>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setText(value);
            setDirty(false);
          }
        }}
        aria-label={label}
        className={`w-full bg-transparent text-sm outline-none ${mono ? "font-mono" : ""}`}
        style={{ color: "var(--m3-on-surface)" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- helpers

/** Deterministic pseudo-random for decorative bars/dots (stable render). */
function rnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Slice badge: honest "sample data" label on every preview. */
export function PreviewBadge({ slice, children }: { slice: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className="mb-3 flex items-center gap-2 rounded-xl px-3 py-2 text-xs"
      style={{ background: "var(--m3-surface-2)", color: "var(--m3-on-surface-variant)" }}
    >
      <MIcon name="visibility" size={15} />
      <span>
        <strong style={{ color: "var(--m3-on-surface)" }}>Preview · sample data.</strong> {children ?? `Arrives with ${slice}.`}
      </span>
      <span className="ml-auto rounded-md px-2 py-0.5 font-mono text-[11px]" style={{ background: "var(--m3-surface-4)" }}>
        {slice}
      </span>
    </div>
  );
}

type Tone = "ok" | "err" | "warn" | "info" | "plain";

const TONES: Record<Tone, { background: string; color: string }> = {
  ok: { background: "rgba(156,214,125,.14)", color: "#9CD67D" },
  err: { background: "rgba(255,180,171,.14)", color: "#FFB4AB" },
  warn: { background: "rgba(232,163,61,.16)", color: "#E8A33D" },
  info: { background: "rgba(185,195,255,.14)", color: "#B9C3FF" },
  plain: { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" },
};

export function Pill({ tone = "plain", children }: { tone?: Tone; children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold"
      style={TONES[tone]}
    >
      {children}
    </span>
  );
}

export function StatTile({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: string }): React.JSX.Element {
  return (
    <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
      <p className="text-[13px]" style={{ color: "var(--m3-on-surface-variant)" }}>{label}</p>
      <p className="text-2xl font-medium" style={accent ? { color: accent } : undefined}>
        {value}
      </p>
      <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{sub}</p>
    </div>
  );
}

/** SVG line chart with area fill (decorative, sample data). */
export function Chart({ points, color, height = 120, fill = true, caption }: {
  points: number[];
  color: string;
  height?: number;
  fill?: boolean;
  caption?: string;
}): React.JSX.Element {
  const w = 300;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(height - 8 - ((p - min) / span) * (height - 20)).toFixed(1)}`).join(" ");
  const id = React.useId().replace(/:/g, "");
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${height}`} className="w-full" style={{ display: "block" }} aria-hidden="true">
        {fill && (
          <>
            <defs>
              <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.35" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={`${path} L${w},${height} L0,${height} Z`} fill={`url(#${id})`} />
          </>
        )}
        <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
      {caption && (
        <p className="mt-1 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{caption}</p>
      )}
    </div>
  );
}

export function BarRow({ label, pct, text, bar }: { label: string; pct: number; text: string; bar: string }): React.JSX.Element {
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-baseline text-xs">
        <span style={{ color: "var(--m3-on-surface)" }}>{label}</span>
        <span className="ml-auto font-mono" style={{ color: "var(--m3-on-surface-variant)" }}>{text}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--m3-surface-4)" }}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: bar }} />
      </div>
    </div>
  );
}

export function MiniTable({ head, rows, mono = false, crud, addLabel }: {
  head: string[];
  rows: React.ReactNode[][];
  mono?: boolean;
  /** Owning slice: adds per-row Inspect/Edit/Duplicate/Delete, staged honestly. */
  crud?: string;
  /** Staged "add" affordance label, e.g. "Add player". */
  addLabel?: string;
}): React.JSX.Element {
  return (
    <div>
      {addLabel && (
        <div className="flex justify-end px-2 pb-1">
          <button
            onClick={() => notify(`${addLabel} — staged for ${crud ?? "the owning slice"}`)}
            title={`${addLabel} (staged)`}
            className="m3-focus flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
            style={{ background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }}
          >
            <MIcon name="add" size={15} />{addLabel}
          </button>
        </div>
      )}
    <table className="w-full border-collapse text-[12.5px]">
      <thead>
        <tr>
          {head.map((h) => (
            <th
              key={h}
              className="sticky top-0 whitespace-nowrap px-2 text-left font-medium"
              style={{ background: "var(--m3-surface-2)", color: "var(--m3-on-surface-variant)", height: 32 }}
            >
              {h}
            </th>
          ))}
          {crud && <th className="w-10" style={{ background: "var(--m3-surface-2)", height: 32 }}><span className="sr-only">Row actions</span></th>}
        </tr>
      </thead>
      <tbody className={mono ? "font-mono text-xs" : undefined}>
        {rows.map((r, i) => (
          <tr key={i} className="group" style={{ borderBottom: "1px solid #2a2b31" }}>
            {r.map((c, j) => (
              <td key={j} className="whitespace-nowrap px-2" style={{ height: 30 }}>{c}</td>
            ))}
            {crud && (
              <td className="px-1" style={{ height: 30 }}>
                <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  {[
                    ["visibility", `Inspect row ${i + 1}`],
                    ["edit", `Edit row ${i + 1}`],
                    ["content_copy", `Duplicate row ${i + 1}`],
                    ["delete", `Delete row ${i + 1}`],
                  ].map(([icon, label]) => (
                    <button
                      key={icon}
                      title={`${label} — staged`}
                      aria-label={`${label} (staged)`}
                      onClick={() => notify(`${label} — staged for ${crud}`)}
                      className="m3-focus rounded-full p-1"
                      style={{ color: "var(--m3-on-surface-variant)" }}
                    >
                      <MIcon name={icon} size={15} />
                    </button>
                  ))}
                </span>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

export function OutlinedField({ label, value, wide = false }: { label: string; value: string; wide?: boolean }): React.JSX.Element {
  return (
    <div
      className={`relative rounded-md px-3.5 pb-1.5 pt-4 ${wide ? "col-span-full" : ""}`}
      style={{ border: "1px solid var(--m3-outline)" }}
    >
      <small
        className="absolute px-1 text-xs"
        style={{ top: -9, left: 10, background: "var(--m3-surface-1)", color: "var(--m3-on-surface-variant)" }}
      >
        {label}
      </small>
      <span className="font-mono text-sm">{value}</span>
    </div>
  );
}

export function SegRow({ label, options, value }: { label: string; options: string[]; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-32 flex-none text-[13px]" style={{ color: "var(--m3-on-surface-variant)" }}>{label}</span>
      <div className="flex h-9 flex-1 items-center overflow-hidden rounded-full text-sm" role="group" aria-label={label} style={{ border: "1px solid var(--m3-outline-variant)" }}>
        {options.map((o) => {
          const on = value === o;
          return (
            <span
              key={o}
              className="flex h-full flex-1 items-center justify-center whitespace-nowrap px-2"
              style={on ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
            >
              {o}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>
      {children}
    </p>
  );
}

// ---------------------------------------------------------------- live ops (ux-08)

export const PLAYERS: Array<[string, string, string, string, string, string]> = [
  ["Aria", "Starter Coast", "0,0", "38 ms", "fighting", "214"],
  ["Bram", "Starter Coast", "0,0", "44 ms", "idle", "12"],
  ["Cass", "Ember Peaks", "1,0", "61 ms", "travelling", "88"],
  ["Dov", "Starter Coast", "0,0", "35 ms", "trading", "7"],
  ["Elin", "Dungeon #12", "instance", "52 ms", "in dungeon", "301"],
  ["Fenn", "Ember Peaks", "1,0", "73 ms", "dead", "40"],
  ["Gale", "Saltmarsh", "0,1", "40 ms", "chatting", "5"],
  ["Hale", "Starter Coast", "0,0", "39 ms", "fighting", "190"],
];

const liveOpsStore = createStore<{ player: string }>({ player: "Aria" });

export { liveOpsStore };

function playerStats(name: string): { hp: string; sp: string; extra: string } {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return {
    hp: `${60 + (h % 41)}/100`,
    sp: `${20 + ((h >> 3) % 75)}`,
    extra: `Swimming ${(5 + ((h >> 5) % 150) / 10).toFixed(1)}`,
  };
}

export function LiveOpsPreview(): React.JSX.Element {
  const { player } = liveOpsStore.use();
  return (
    <div className="flex flex-col gap-3">
      <PreviewBadge slice="EA · Live ops (A1–A5)">Stat tiles, charts and the players table bind to the admin console and telemetry.</PreviewBadge>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        <StatTile label="Players online" value="214" sub="▲ 18 in the last hour" />
        <StatTile label="Server tick p99" value="9.7 ms" sub="budget 33 ms" accent="#9CD67D" />
        <StatTile label="Edge ↔ core RTT" value="41 ms" sub="p99 62 ms" />
        <StatTile label="Regions" value="4 / 4 up" sub="world server healthy" accent="#9CD67D" />
        <StatTile label="Sidecars" value="2 running" sub="weather-ai · dungeon.layout" />
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
          <p className="mb-2 text-sm font-medium">Players</p>
          <Chart points={[42, 58, 74, 88, 82, 96, 118, 142, 168, 190, 214]} color="#B9C3FF" />
        </div>
        <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
          <p className="mb-2 text-sm font-medium">Tick time</p>
          <Chart points={[8, 10, 9, 11, 9, 22, 10, 9, 8, 9, 8]} color="#9CD67D" caption="spike at 14:31 · region 1,0 bake" />
        </div>
        <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
          <p className="mb-2 text-sm font-medium">Edge ↔ core</p>
          <Chart points={[40, 44, 38, 42, 46, 62, 44, 40, 39, 41, 41]} color="#FFB59A" caption="frames 1.9k/s · channel up · 0 resyncs" />
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl" style={{ background: "var(--m3-surface-2)" }}>
        <div className="flex items-center p-3 pb-0 text-sm font-medium">
          Players
          <button
            onClick={() => notify("Add player — staged for EA · live ops (seeded editor accounts in play setups)")}
            title="Add player (staged)"
            className="m3-focus ml-auto flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
            style={{ background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }}
          >
            <MIcon name="add" size={15} />Add
          </button>
        </div>
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              {["Character", "Scene", "Region", "RTT", "State", "Actions/min"].map((h) => (
                <th key={h} className="whitespace-nowrap px-2 text-left font-medium" style={{ color: "var(--m3-on-surface-variant)", height: 32 }}>{h}</th>
              ))}
              <th className="w-10" style={{ height: 32 }}><span className="sr-only">Row actions</span></th>
            </tr>
          </thead>
          <tbody>
            {PLAYERS.map(([c, s, r, rtt, st, a]) => {
              const on = c === player;
              return (
                <tr
                  key={c}
                  onClick={() => liveOpsStore.set({ player: c })}
                  className="group cursor-pointer"
                  title={`Inspect ${c} in the admin console`}
                  style={{ borderBottom: "1px solid #2a2b31", background: on ? "#2b2f4a" : undefined }}
                >
                  <td className="px-2" style={{ height: 30 }}>{c}</td>
                  <td className="px-2" style={{ height: 30 }}>{s}</td>
                  <td className="px-2 font-mono" style={{ height: 30 }}>{r}</td>
                  <td className="px-2 font-mono" style={{ height: 30 }}>{rtt}</td>
                  <td className="px-2" style={{ height: 30 }}><Pill tone={st === "dead" ? "err" : "info"}>{st}</Pill></td>
                  <td className="px-2 font-mono" style={{ height: 30 }}>{a}</td>
                  <td className="px-1" style={{ height: 30 }} onClick={(e) => e.stopPropagation()}>
                    <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <OverflowMenu
                        label={`${c} actions`}
                        items={[
                          { label: `Inspect ${c}`, icon: "search", run: () => liveOpsStore.set({ player: c }) },
                          "sep",
                          { label: "Teleport…", icon: "teleport", stagedFor: "EA · live ops" },
                          { label: "Send message…", icon: "mail", stagedFor: "EA · live ops" },
                          { label: "Kick", icon: "logout", danger: true, stagedFor: "EA · live ops" },
                        ]}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[
          ["Starter Coast", "region 0,0", "121", "tick 4.1 ms", "#1F5110"],
          ["Ember Peaks", "region 1,0", "48", "tick 7.9 ms", "#3d2b12"],
          ["Saltmarsh", "region 0,1", "33", "tick 3.2 ms", "#1c2f3a"],
          ["Frost Reach", "region 1,1", "12", "tick 2.4 ms", "#2b2f4a"],
        ].map(([name, sub, n, tick, bg]) => (
          <div key={name} className="rounded-xl p-3" style={{ background: bg }}>
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-medium">{name}</p>
              <p className="text-xl">{n}</p>
            </div>
            <p className="font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>{sub}</p>
            <p className="mt-4 font-mono text-xs" style={{ color: "#9CD67D" }}>● {tick}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LiveOpsDetails(): React.JSX.Element {
  const { player } = liveOpsStore.use();
  const st = playerStats(player);
  return (
    <div className="flex flex-col gap-2 font-mono text-xs leading-relaxed">
      <p className="font-sans text-sm font-medium" style={{ color: "var(--m3-on-surface)" }}>Admin console</p>
      <p style={{ color: "var(--m3-on-surface-variant)" }}>&gt; inspect {player}</p>
      <p style={{ color: "var(--m3-on-surface)" }}>Health {st.hp} · Stamina {st.sp} · {st.extra}</p>
      <p style={{ color: "var(--m3-on-surface-variant)" }}>&gt; teleport {player} 120 0 -40</p>
      <p style={{ color: "var(--m3-on-surface)" }}>ok</p>
      <div className="rounded-lg p-2" style={{ background: "var(--m3-surface-3)" }}>
        <span style={{ color: "var(--m3-on-surface-variant)" }}>&gt; spawn </span>
        <span style={{ color: "var(--m3-primary)" }}>goblin</span>
        <span style={{ color: "var(--m3-on-surface-variant)" }}> x3 at </span>
        <span style={{ color: "var(--m3-primary)" }}>{player}</span>
        <span className="animate-pulse">▊</span>
      </div>
      <SectionLabel>Events</SectionLabel>
      {[
        ["[party]", "#7aa2ff", "Aria: pull the shaman first"],
        ["[guild]", "#9CD67D", "Elin: dungeon 12 cleared"],
        ["[admin]", "#FFB59A", "P: spawn goblin x3 at Aria"],
        ["[ingress]", "#FFB4AB", "1 session over intent limit (Fenn)"],
        ["[ledger]", "#C3C5DD", "1,284 events flushed · checkpoint 14:32"],
      ].map(([tag, color, text]) => (
        <p key={tag} style={{ color: "var(--m3-on-surface-variant)" }}>
          <span style={{ color: color as string }}>{tag}</span> {text}
        </p>
      ))}
      <EcsChips components={["CharacterRef", "Transform", "Velocity", "Health", "Stamina", "Appearance"]} caption={`${player} in the live world is these components plus ledger rows. The Scene workspace ECS inspector reads them; BackendClient.inspect dumps them.`} />
    </div>
  );
}

// ---------------------------------------------------------------- database (ux-09, ux-10)

const SCHEMA: Array<[string, Array<[string, string?, string?]>]> = [
  ["world.db", [["snapshots", "6"], ["events", "18.2k", "ledger"], ["chunk_entities", "41k"], ["formation_tiles_v2", "2.3k"], ["item_events", "128k", "ledger"], ["item_latest", "9.4k", "cache"], ["terrain_tiles", "1.0k"]]],
  ["characters.db", [["characters", "312"], ["character_state", "312"], ["character_skills", "298"], ["deaths", "4.1k"], ["admin_log", "57"]]],
  ["guilds.db", []], ["social.db", []], ["navmesh.db", []],
];

interface DbDraft {
  id: number;
  field: string;
  before: string;
  after: string;
}

interface DbState {
  table: string;
  rowId: number;
  drafts: DbDraft[];
}

const dbStore = createStore<DbState>({
  table: "character_state",
  rowId: 17,
  drafts: [
    { id: 17, field: "health", before: "0", after: "100" },
    { id: 17, field: "stamina", before: "0", after: "100" },
  ],
});

export { dbStore };

function upsertDraft(field: string, after: string, base: Record<number, Record<string, string>>, rowId: number): void {
  dbStore.set((prev) => {
    const before = base[rowId]?.[field] ?? "";
    if (after === before) return { ...prev, drafts: prev.drafts.filter((d) => !(d.id === rowId && d.field === field)) };
    const rest = prev.drafts.filter((d) => !(d.id === rowId && d.field === field));
    return { ...prev, drafts: [...rest, { id: rowId, field, before, after }] };
  });
}

/** Schema structure decomposed from the persistence core (§7b): owners + columns. */
const TABLE_INFO: Record<string, { rows: string; owner: string; columns: string[] }> = {
  snapshots: { rows: "6", owner: "SnapshotStore", columns: ["tick", "bytes", "generation"] },
  events: { rows: "18.2k", owner: "ItemLedger", columns: ["seq", "tick", "kind", "payload"] },
  chunk_entities: { rows: "41k", owner: "ChunkEntityStore", columns: ["chunk", "wire_id", "blob"] },
  formation_tiles_v2: { rows: "2.3k", owner: "FormationTileStore", columns: ["region", "tile", "blob"] },
  item_events: { rows: "128k", owner: "ItemLedger", columns: ["seq", "item", "kind", "x", "y", "z"] },
  item_latest: { rows: "9.4k", owner: "PersistenceCore", columns: ["item", "seq", "chunk"] },
  terrain_tiles: { rows: "1.0k", owner: "TerrainTileStore", columns: ["x", "z", "blob"] },
  characters: { rows: "312", owner: "SqliteCharacterStore", columns: ["id", "account", "name", "created"] },
  character_state: { rows: "312", owner: "SqliteCharacterStore", columns: ["character_id", "x", "y", "z", "health", "stamina", "saved_at"] },
  character_skills: { rows: "298", owner: "SqliteCharacterStore", columns: ["character_id", "skill", "level"] },
  deaths: { rows: "4.1k", owner: "SqliteCharacterStore", columns: ["character_id", "tick", "cause"] },
  admin_log: { rows: "57", owner: "PersistenceCore", columns: ["tick", "admin", "mutation", "result"] },
};

export function SchemaTree(): React.JSX.Element {
  const { table } = dbStore.use();
  const [open, setOpen] = React.useState<string[]>(["characters.db"]);
  const toggle = (id: string): void => setOpen((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const crud = (label: string): Array<MenuItem | "sep"> => [
    { label: `Inspect ${label}`, icon: "search", run: () => dbStore.set((p) => ({ ...p, table: label })) },
    "sep",
    { label: "Rename…", icon: "edit", stagedFor: "EA · database" },
    { label: "Duplicate", icon: "content_copy", stagedFor: "EA · database" },
    { label: "Delete", icon: "delete", danger: true, stagedFor: "EA · database" },
  ];
  return (
    <div className="flex flex-col gap-0.5">
      {SCHEMA.map(([db, tables]) => {
        const dbOpen = open.includes(db);
        return (
          <div key={db}>
            <TreeItem
              icon="database" label={db} mono
              hasKids expanded={dbOpen} onToggle={() => toggle(db)}
              selected={false} onPick={() => toggle(db)}
              menu={[
                { label: "New table…", icon: "note_add", stagedFor: "EA · database" },
                { label: "Backup…", icon: "save", stagedFor: "EA · database" },
              ]}
            />
            {dbOpen && tables.map(([t, n, tag]) => {
              const on = t === table;
              const tOpen = open.includes(t);
              const cols = TABLE_INFO[t]?.columns ?? [];
              return (
                <div key={t}>
                  <TreeItem
                    icon="table_view" label={t} trailing={`${tag ? `${tag} · ` : ""}${n}`} depth={1} mono
                    hasKids={cols.length > 0} expanded={tOpen} onToggle={() => toggle(t)}
                    selected={on} onPick={() => dbStore.set((p) => ({ ...p, table: t }))}
                    menu={crud(t)}
                  />
                  {tOpen && cols.map((c) => (
                    <TreeItem
                      key={c} icon="chevron_right" label={c} depth={2} mono
                      menu={crud(`${t}.${c}`)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

const GRID_BASE: Record<number, Record<string, string>> = {
  12: { name: "Aria", x: "120.4", y: "4.2", z: "-40.1", health: "74", stamina: "41", saved: "14:31:02" },
  13: { name: "Bram", x: "88.0", y: "3.9", z: "-12.5", health: "100", stamina: "88", saved: "14:31:02" },
  14: { name: "Cass", x: "612.7", y: "48.0", z: "233.9", health: "63", stamina: "20", saved: "14:31:01" },
  15: { name: "Dov", x: "97.2", y: "4.1", z: "-30.0", health: "100", stamina: "100", saved: "14:31:02" },
  16: { name: "Elin", x: "0.0", y: "0.0", z: "0.0", health: "55", stamina: "70", saved: "14:30:58" },
  17: { name: "Fenn", x: "640.3", y: "51.2", z: "210.4", health: "0", stamina: "0", saved: "14:31:00" },
  18: { name: "Gale", x: "-210.8", y: "1.2", z: "560.0", health: "92", stamina: "64", saved: "14:31:02" },
  19: { name: "Hale", x: "131.9", y: "4.4", z: "-44.2", health: "81", stamina: "52", saved: "14:31:02" },
};

function effective(base: Record<number, Record<string, string>>, drafts: DbDraft[], id: number, field: string): { value: string; drafted: boolean } {
  const d = drafts.find((x) => x.id === id && x.field === field);
  return d ? { value: d.after, drafted: true } : { value: base[id]?.[field] ?? "", drafted: false };
}

export function DataGridPreview(): React.JSX.Element {
  const { table, rowId, drafts } = dbStore.use();
  const info = TABLE_INFO[table];
  const isState = table === "character_state";
  const ids = Object.keys(GRID_BASE).map(Number);

  return (
    <div className="flex flex-col gap-2">
      <PreviewBadge slice="EA · Database (§7b)">Reads run on a worker snapshot; writes are typed mutations applied between ticks.</PreviewBadge>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-mono" style={{ color: "var(--m3-on-surface-variant)" }}>
          {table === "character_state" ? "characters.db" : "world.db"} › {table}
        </span>
        <Pill tone="info">⚡ Live via persistence core</Pill>
        {info && <Pill tone="plain">owner: {info.owner}</Pill>}
        {isState && (
          <span className="ml-auto rounded-lg border px-3 py-1.5 font-mono text-xs" style={{ borderColor: "var(--m3-outline-variant)", color: "var(--m3-on-surface-variant)" }}>
            health &lt; 50
          </span>
        )}
        {isState && (
          <button
            onClick={() => notify("Add row — staged for EA · database (typed insert via the owning store)")}
            title="Add row (staged — append-only tables stay read-only)"
            className="m3-focus flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
            style={{ background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }}
          >
            <MIcon name="add" size={15} />Add row
          </button>
        )}
      </div>
      {drafts.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl px-3 py-2.5 text-sm" style={{ background: "var(--m3-primary-container)", color: "var(--m3-on-primary-container)" }}>
          <MIcon name="edit" size={17} />
          <strong>{drafts.length} pending mutation{drafts.length === 1 ? "" : "s"}</strong>
          <span className="font-mono text-xs">
            {drafts.map((d) => `${table}[${d.id}] ${d.field} ${d.before}→${d.after}`).join(" · ")}
          </span>
          <span className="ml-auto flex gap-2">
            <button onClick={() => dbStore.set((p) => ({ ...p, drafts: [] }))} className="m3-focus rounded-full px-2 py-1 hover:bg-white/10">
              Discard
            </button>
            <span
              className="rounded-full px-3 py-1 font-semibold opacity-60"
              style={{ background: "var(--m3-primary)", color: "var(--m3-on-primary)" }}
              title="Send to core needs the persistence-core slice (typed mutations over admin 0x10). Drafts stay local until then."
            >
              ▷ Send to core
            </span>
          </span>
        </div>
      )}
      {isState ? (
        <div className="overflow-x-auto rounded-xl" style={{ background: "var(--m3-surface-2)" }}>
          <table className="w-full border-collapse font-mono text-xs">
            <thead>
              <tr>
                {["character_id ↑", "name (join)", "x", "y", "z", "health", "stamina", "saved_at"].map((h) => (
                  <th key={h} className="whitespace-nowrap px-2 text-left font-medium" style={{ background: "var(--m3-surface-2)", color: "var(--m3-on-surface-variant)", height: 32 }}>{h}</th>
                ))}
                <th className="w-10" style={{ background: "var(--m3-surface-2)", height: 32 }}><span className="sr-only">Row actions</span></th>
              </tr>
            </thead>
            <tbody>
              {ids.map((id) => {
                const on = id === rowId;
                return (
                  <tr
                    key={id}
                    onClick={() => dbStore.set((p) => ({ ...p, rowId: id }))}
                    className="group cursor-pointer"
                    style={{ borderBottom: "1px solid #2a2b31", background: on ? "#2b2f4a" : undefined }}
                  >
                    <td className="px-2" style={{ height: 30 }}>{id}</td>
                    <td className="px-2" style={{ fontFamily: "var(--m3-font-ui)" }}>{GRID_BASE[id].name}</td>
                    {(["x", "y", "z", "health", "stamina"] as const).map((f) => {
                      const eff = effective(GRID_BASE, drafts, id, f);
                      return (
                        <td key={f} className="px-2" style={{ height: 30 }}>
                          <span style={eff.drafted ? { boxShadow: "inset 0 0 0 2px var(--m3-primary)", background: "#1f2440", padding: "2px 8px" } : undefined}>
                            {eff.value}{eff.drafted ? " θ" : ""}
                          </span>
                        </td>
                      );
                    })}
                    <td className="px-2" style={{ height: 30 }}>{GRID_BASE[id].saved}</td>
                    <td className="px-1" style={{ height: 30 }} onClick={(e) => e.stopPropagation()}>
                      <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <OverflowMenu
                          label={`Row ${id} actions`}
                          items={[
                            { label: `Inspect row ${id}`, icon: "search", run: () => dbStore.set((p) => ({ ...p, rowId: id })) },
                            "sep",
                            { label: "Duplicate row", icon: "content_copy", stagedFor: "EA · database" },
                            { label: "Delete row", icon: "delete", danger: true, stagedFor: "EA · database" },
                          ]}
                        />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="flex justify-between px-3 py-2 font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>
            <span>312 rows · page 2 of 26 · read from a read-only snapshot in a worker</span>
            <span>last applied: tick 18,402</span>
          </div>
        </div>
      ) : (
        <div className="rounded-xl p-4" style={{ background: "var(--m3-surface-2)" }}>
          <p className="font-mono text-sm">
            {table} <span style={{ color: "var(--m3-on-surface-variant)" }}>· {info?.rows ?? "?"} rows · owner {info?.owner}</span>
          </p>
          <p className="mt-2 text-[13px]" style={{ color: "var(--m3-on-surface-variant)" }}>Columns</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {(info?.columns ?? []).map((c) => (
              <span key={c} className="rounded-md px-2 py-1 font-mono text-xs" style={{ background: "var(--m3-surface-4)" }}>{c}</span>
            ))}
          </div>
          <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
            Full row grid for this table arrives with the slice — character_state is the staged sample. Append-only
            tables (events, item_events, snapshots) stay read-only even then.
          </p>
        </div>
      )}
      <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
        <p className="mb-2 text-sm font-medium">Audit log</p>
        <MiniTable
          mono
          head={["Tick", "Admin", "Mutation", "Result", ""]}
          rows={[
            ["18,402", "P", "character_state[12].health 60→74", <Pill tone="ok">applied</Pill>, <UndoMutation label="character_state[12].health 60→74" />],
            ["18,377", "P", "item 88213 → ledger: moved to bag 4/2", <Pill tone="ok">event #128,904</Pill>, <UndoMutation label="item 88213 move" />],
            ["18,350", "P", 'characters[30].name "x" → "Xan"', <Pill tone="err">refused: name taken</Pill>, <UndoMutation label="characters[30].name" />],
            ["18,120", "P", "guild_members[7].rank recruit→member", <Pill tone="ok">applied</Pill>, <UndoMutation label="guild_members[7].rank" />],
          ]}
        />
      </div>
    </div>
  );
}

function UndoMutation({ label }: { label: string }): React.JSX.Element {
  return (
    <button
      onClick={() => notify(`Undo ${label} — staged for EA · database (inverse mutation via the audit log)`)}
      title={`Undo ${label} (staged)`}
      aria-label={`Undo ${label} (staged)`}
      className="m3-focus rounded-full p-1"
      style={{ color: "var(--m3-on-surface-variant)" }}
    >
      ↩
    </button>
  );
}

export function DatabaseRowDetails(): React.JSX.Element {
  const { rowId, drafts } = dbStore.use();
  const base = GRID_BASE[rowId] ?? GRID_BASE[17];
  return (
    <div className="flex flex-col gap-2.5">
      <p className="font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
        ROW {rowId} · {base.name.toUpperCase()}
      </p>
      {(["health", "stamina"] as const).map((f) => (
        <DraftField
          key={`${rowId}-${f}`}
          label={f}
          value={effective(GRID_BASE, drafts, rowId, f).value}
          onCommit={(next) => upsertDraft(f, next, GRID_BASE, rowId)}
        />
      ))}
      <DraftField
        key={`${rowId}-name`}
        label="name (join → characters)"
        value={effective(GRID_BASE, drafts, rowId, "name").value}
        onCommit={(next) => upsertDraft("name", next, GRID_BASE, rowId)}
      />
      <div className="rounded-xl p-2.5 text-xs leading-relaxed" style={{ background: "var(--m3-surface-2)", color: "var(--m3-on-surface-variant)" }}>
        ⓘ Edits collect as pending mutations above. Applied between ticks through SqliteCharacterStore.saveState, so
        the live character changes with the row.
      </div>
      <SectionLabel>Related</SectionLabel>
      {[`characters[${rowId}] · ${base.name}`, "deaths · 6 rows", `item_latest · owner ${rowId} · 14`].map((r) => (
        <p key={r} className="font-mono text-xs" style={{ color: "var(--m3-on-surface)" }}>{r}</p>
      ))}
      <EcsChips components={["Transform", "Health", "Stamina", "CharacterRef"]} caption={`character_state[${rowId}] is the persisted shadow of a live entity carrying these components.`} />
      <SectionLabel>Mode</SectionLabel>
      <div className="flex h-9 items-center overflow-hidden rounded-full text-sm" style={{ border: "1px solid var(--m3-outline-variant)" }}>
        {["Live", "Read", "Maintenance"].map((m, i) => (
          <span key={m} className="flex h-full flex-1 items-center justify-center" style={i === 0 ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}>
            {m}
          </span>
        ))}
      </div>
    </div>
  );
}

export function QueryPreview(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <PreviewBadge slice="EA · Database (§7b)">Read-only SQL with the registered deterministic functions in autocomplete.</PreviewBadge>
      <div className="rounded-xl p-4 font-mono text-[13px] leading-[1.9]" style={{ background: "var(--m3-surface-0)" }}>
        <p><span style={{ color: "#7aa2ff" }}>SELECT</span> <span style={{ color: "#E8A33D" }}>item_def(def)</span> <span style={{ color: "#7aa2ff" }}>AS</span> item, <span style={{ color: "#7aa2ff" }}>count(*)</span> <span style={{ color: "#7aa2ff" }}>AS</span> n</p>
        <p><span style={{ color: "#7aa2ff" }}>FROM</span> item_latest</p>
        <p><span style={{ color: "#7aa2ff" }}>WHERE</span> <span style={{ color: "#E8A33D" }}>chunk_of(x, z)</span> = <span style={{ color: "#E8A33D" }}>chunk_of(120, -40)</span></p>
        <p>&nbsp;&nbsp;<span style={{ color: "#7aa2ff" }}>AND</span> kind = <span style={{ color: "#9CD67D" }}>'ground'</span></p>
        <p><span style={{ color: "#7aa2ff" }}>GROUP BY</span> item <span style={{ color: "#7aa2ff" }}>ORDER BY</span> n <span style={{ color: "#7aa2ff" }}>DESC</span>;</p>
      </div>
      <div className="flex items-center gap-2">
        <span className="rounded-full px-4 py-2 text-sm font-semibold" style={{ background: "var(--m3-primary)", color: "var(--m3-on-primary)" }}>▷&nbsp; Run (read-only)</span>
        <span className="rounded-full px-4 py-2 text-sm" style={{ background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }}>⚙ Explain</span>
        <span className="ml-auto font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>6 rows · 0.4 ms · worker connection</span>
      </div>
      <div className="rounded-xl" style={{ background: "var(--m3-surface-2)" }}>
        <MiniTable
          crud="EA · database"
          head={["item", "n"]}
          rows={[["Rusty dagger", "14"], ["Goblin axe", "9"], ["Copper ore", "7"], ["Wolf pelt", "5"], ["Iron mace", "2"], ["Healing herb", "1"]]}
        />
      </div>
      <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
        <p className="mb-2 font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>⚙ QUERY PLAN</p>
        <div className="font-mono text-xs leading-[1.9]" style={{ color: "var(--m3-on-surface-variant)" }}>
          <p>├ SEARCH item_latest USING INDEX item_latest_chunk (chunk_of(x,z)=?)</p>
          <p>├ USE TEMP B-TREE FOR GROUP BY</p>
          <p>└ USE TEMP B-TREE FOR ORDER BY</p>
        </div>
        <p className="mt-2 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: "#1F5110", color: "#d7f8c3" }}>✓ Uses the expression index on chunk_of(x, z). No full scan.</p>
        <p className="mt-2 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: "#3d2b12", color: "#E8A33D" }}>⚠ Same query on item_events would SCAN 128k rows. Use item_latest.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
          <p className="mb-2 text-sm font-medium">Statements</p>
          <MiniTable
            mono
            crud="EA · database"
            head={["Statement", "calls/min", "p50", "p99"]}
            rows={[
              ["characters.byId", "1,920", "6 µs", "21 µs"],
              ["characters.saveState", "214", "18 µs", "70 µs"],
              ["ledger.appendBatch", "60", "0.9 ms", "3.1 ms"],
              ["ledger.latestForItem", "310", "4 µs", "15 µs"],
              ["chunks.entitiesIn", "95", "0.2 ms", "0.8 ms"],
              ["guilds.roster", "40 ⚠", "31 µs", "2.4 ms"],
            ]}
          />
        </div>
        <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
          <p className="mb-2 text-sm font-medium">Caches</p>
          <BarRow label="character by id" pct={98.7} text="98.7% · 312 / 512" bar="#9CD67D" />
          <BarRow label="item definition" pct={99.9} text="99.9% · 1,204" bar="#9CD67D" />
          <BarRow label="guild roster" pct={71.2} text="71.2% · 38 / 64" bar="#E8A33D" />
          <BarRow label="chunk entities" pct={93.4} text="93.4% · 289 / 1,024" bar="#9CD67D" />
          <SectionLabel>Pragmas · world.db</SectionLabel>
          <p className="font-mono text-xs leading-[1.9]" style={{ color: "var(--m3-on-surface-variant)" }}>
            journal_mode wal · synchronous normal<br />
            cache_size -65536 · mmap_size 256 MB<br />
            WAL 3.1 MB · last checkpoint 14:31:05 (worker)
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- story (ux-13, ux-18)

const QUEST_NODES: Record<string, { title: string; header: string; lines: string[] }> = {
  talk: { title: "Talk to Warden Hale", header: "#36449A", lines: ["Hale · Starter Coast", "dialog: hale.intro"] },
  clear: { title: "Clear a goblin camp", header: "#7A2E12", lines: ["slot: goblin camp ≤ 2 chunks", "seed 1337 · camp at 3,1", "kill 6 · goblin"] },
  return: { title: "Return to Hale", header: "#36449A", lines: ["dialog: hale.return"] },
  reward: { title: "Reward", header: "#1F5110", lines: ["40 silver", "loot: hale_reward", "standing +10"] },
  refused: { title: "Refused", header: "#5a3a1a", lines: ['"I\'ll think about it"', "leads nowhere"] },
  collect: { title: "Collect goblin ears", header: "#7A2E12", lines: ["3 × goblin_ear", "drop 60 % (goblin_quest)"] },
  optional: { title: "Optional: the tower", header: "#3a3355", lines: ["instance: watchtower", "slot: dungeon pool · d1"] },
  bonus: { title: "Bonus reward", header: "#1F5110", lines: ["loot: tower_cache", "unlocks: tower-key"] },
};

const storyStore = createStore<{ node: string; lines: Record<string, string[]> }>({
  node: "clear",
  lines: {},
});

export { storyStore };

function QuestNode({ id, x, y, w }: { id: string; x: number; y: number; w: number }): React.JSX.Element {
  const { node, lines } = storyStore.use();
  const n = QUEST_NODES[id];
  const rendered = lines[id] ?? n.lines;
  const selected = node === id;
  const h = 34 + rendered.length * 20;
  return (
    <g
      onClick={() => storyStore.set((p) => ({ ...p, node: id }))}
      style={{ cursor: "pointer" }}
    >
      <title>{n.title} — click to inspect</title>
      <rect x={x} y={y} width={w} height={h} rx="10" fill="#1E1F25" stroke={selected ? "#B9C3FF" : "#46464F"} strokeWidth={selected ? 2 : 1} />
      <rect x={x} y={y} width={w} height="30" rx="10" fill={n.header} />
      <rect x={x} y={y + 20} width={w} height="14" fill={n.header} />
      <text x={x + 12} y={y + 20} fill="#E3E1E9" fontSize="12" fontWeight="600">{n.title}</text>
      {rendered.map((l, i) => (
        <text key={i} x={x + 12} y={y + 50 + i * 20} fill={selected ? "#E3E1E9" : "#C6C5D0"} fontSize="11" fontFamily="Roboto Mono, monospace">{l}</text>
      ))}
    </g>
  );
}

export function QuestPreview(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <PreviewBadge slice="EA · Story (§7c.3)">Quest and dialog graphs with the dialog tester and quest state.</PreviewBadge>
      <div className="flex items-center gap-2 text-[13px]">
        <span className="font-mono" style={{ color: "var(--m3-on-surface-variant)" }}>content/quests/warden-hale.quest.json</span>
        <Pill tone="info">1 slot · generated</Pill>
        <span className="ml-auto flex gap-2">
          <Pill tone="plain">◈ Seed 1337</Pill>
          <Pill tone="plain">▷ Play from step</Pill>
        </span>
      </div>
      <svg viewBox="0 0 900 340" className="w-full rounded-xl" style={{ background: "var(--m3-surface-0)", backgroundImage: "radial-gradient(#2a2b31 1px, transparent 1px)", backgroundSize: "22px 22px" }} role="img" aria-label="Quest graph preview">
        <defs>
          <marker id="ah" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="#90909A" />
          </marker>
        </defs>
        {/* top row */}
        <path d="M170,80 C210,80 210,70 250,70" stroke="#90909A" fill="none" markerEnd="url(#ah)" />
        <path d="M440,70 C480,70 480,80 520,80" stroke="#90909A" fill="none" markerEnd="url(#ah)" />
        <path d="M670,80 C700,80 700,80 730,80" stroke="#90909A" fill="none" markerEnd="url(#ah)" />
        {/* refuse branch */}
        <path d="M95,132 L95,220" stroke="#90909A" strokeDasharray="5 4" fill="none" />
        <text x="102" y="180" fill="#C6C5D0" fontSize="10" fontFamily="Roboto Mono, monospace">refuse</text>
        {/* collect branch */}
        <path d="M345,142 L345,220" stroke="#90909A" fill="none" />
        <text x="352" y="185" fill="#C6C5D0" fontSize="10" fontFamily="Roboto Mono, monospace">camp cleared</text>
        {/* collect → optional → bonus */}
        <path d="M440,262 L520,262" stroke="#90909A" strokeDasharray="5 4" fill="none" markerEnd="url(#ah)" />
        <path d="M690,262 L730,262" stroke="#90909A" fill="none" markerEnd="url(#ah)" />
        {/* collect → return (3 ears handoff) */}
        <path d="M420,240 C480,220 500,160 540,120" stroke="#90909A" fill="none" markerEnd="url(#ah)" />
        <text x="478" y="170" fill="#C6C5D0" fontSize="10" fontFamily="Roboto Mono, monospace">3 ears</text>
        <QuestNode id="talk" x={20} y={40} w={150} />
        <QuestNode id="clear" x={250} y={30} w={190} />
        <QuestNode id="return" x={520} y={40} w={150} />
        <QuestNode id="reward" x={730} y={40} w={150} />
        <QuestNode id="refused" x={20} y={220} w={150} />
        <QuestNode id="collect" x={250} y={220} w={190} />
        <QuestNode id="optional" x={520} y={220} w={170} />
        <QuestNode id="bonus" x={730} y={220} w={150} />
      </svg>
      <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
        <p className="mb-2 text-sm font-medium">Validation</p>
        <MiniTable
          head={["", "Problem", "Where"]}
          rows={[
            ["ⓘ", "Reply leads nowhere", <span className="font-mono">hale.intro › reply 3</span>],
            ["⚠", "3 lines missing in fr", <span className="font-mono">hale.intro</span>],
            ["✓", "Reward items exist", <span className="font-mono">loot: hale_reward</span>],
          ]}
        />
      </div>
    </div>
  );
}

export function StoryDetails(): React.JSX.Element {
  const { node, lines } = storyStore.use();
  const n = QUEST_NODES[node];
  const rendered = lines[node] ?? n.lines;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">
        <span style={{ color: "var(--m3-on-surface-variant)" }}>Step · </span>{n.title}
      </p>
      {rendered.map((l, i) => (
        <DraftField
          key={`${node}-${i}`}
          label={`line ${i + 1}`}
          value={l}
          mono
          onCommit={(next) => storyStore.set((p) => ({
            ...p,
            lines: { ...p.lines, [node]: (p.lines[node] ?? n.lines).map((old, j) => (j === i ? next : old)) },
          }))}
        />
      ))}
      <p className="text-sm font-medium">Dialog tester</p>
      <div className="flex flex-col gap-2 text-[13px]">
        <p className="flex gap-2">
          <span className="grid h-7 w-7 flex-none place-items-center rounded-full text-xs font-semibold" style={{ background: "var(--m3-primary-container)", color: "var(--m3-on-primary-container)" }}>H</span>
          <span className="rounded-xl rounded-tl-sm px-3 py-2" style={{ background: "var(--m3-surface-2)" }}>Goblins took the old watchtower. Clear their camp east of here and bring me proof.</span>
        </p>
        <p className="flex gap-2">
          <span className="grid h-7 w-7 flex-none place-items-center rounded-full text-xs font-semibold" style={{ background: "var(--m3-primary-container)", color: "var(--m3-on-primary-container)" }}>H</span>
          <span className="rounded-xl rounded-tl-sm px-3 py-2" style={{ background: "var(--m3-surface-2)" }}>Three ears should do. They won't miss them.</span>
        </p>
        <p className="ml-auto rounded-full px-4 py-1.5" style={{ border: "1px solid var(--m3-primary)", color: "var(--m3-primary)" }}>I'll do it.</p>
        <p className="ml-auto rounded-full px-4 py-1.5" style={{ border: "1px solid var(--m3-outline-variant)" }}>What's in it for me?</p>
        <p className="ml-auto rounded-full px-4 py-1.5" style={{ border: "1px solid var(--m3-tertiary)", color: "var(--m3-tertiary)" }}>I'll think about it.</p>
      </div>
      <SectionLabel>Quest state</SectionLabel>
      <div className="font-mono text-xs leading-[1.9]">
        {[["warden_hale.step", "talk"], ["standing.coast", "15"], ["skill.swords", "22"], ["bag.goblin_ear", "0"]].map(([k, v]) => (
          <p key={k} className="flex" style={{ color: "var(--m3-on-surface-variant)" }}>
            {k}<span className="ml-auto" style={{ color: "var(--m3-on-surface)" }}>{v}</span>
          </p>
        ))}
      </div>
      <EcsChips components={["Spawner", "Transform"]} caption="Quest slots instantiate spawner entities carrying these components — the link between the graph above and the ECS base." />
      <SectionLabel>Beat history</SectionLabel>
      {[["forum", "hale.intro.1", "Hale"], ["forum", "hale.intro.2", "Hale"], ["call_split", "3 replies", "player"], ["flag", "sets warden_hale.step", "on accept"]].map(([icon, label, trailing]) => (
        <p key={label} className="flex items-center gap-2 text-xs" style={{ color: "var(--m3-on-surface)" }}>
          <MIcon name={icon} size={15} />{label}
          <span className="ml-auto" style={{ color: "var(--m3-on-surface-variant)" }}>{trailing}</span>
        </p>
      ))}
    </div>
  );
}

const STRINGS: Array<[string, string, string, string, string]> = [
  ["ui.hud.health", "Health", "Santé", "Leben", "Salud"],
  ["ui.hud.stamina", "Stamina", "Endurance", "Ausdauer", "Aguante"],
  ["ui.bag.title", "Bag ({count} items)", "Sac ({count} objets)", "Tasche ({count} Gegenstände)", "!!!missing!!!"],
  ["ui.settings.uiScale", "UI scale", "Échelle de l'interface", "UI-Skalierung", "Escala de la IU"],
  ["item.goblin_ear", "Goblin ear", "Oreille de gobelin", "Goblinohr", "Oreja de goblin"],
  ["creature.goblin", "Goblin", "Gobelin", "Goblin", "Goblin"],
  ["hale.intro.1", "Goblins took the old watchto…", "!!!missing!!!", "!!!stale!!! Goblins haben den alt…", "!!!missing!!!"],
  ["hale.intro.2", "Three ears should do. They …", "!!!missing!!!", "Drei Ohren reichen. Sie werd…", "!!!missing!!!"],
  ["hale.reply.accept", "I'll do it.", "Je m'en charge.", "Ich mach's.", "Lo haré."],
];

const stringsStore = createStore<{ row: string | null; drafts: Record<string, string> }>({
  row: "hale.intro.1",
  drafts: {},
});

export { stringsStore };

function StrCell({ id, lang, v }: { id: string; lang: string; v: string }): React.JSX.Element {
  const { drafts } = stringsStore.use();
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState("");
  const key = `${id}·${lang}`;
  const draft = drafts[key];
  if (v === "!!!missing!!!" && !draft && !editing) {
    return (
      <button onClick={() => { setText(""); setEditing(true); }} className="m3-focus" title="Click to add the missing translation (local draft)">
        <Pill tone="err">missing</Pill>
      </button>
    );
  }
  if (editing) {
    return (
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (text.trim() !== "" && text !== v) {
            stringsStore.set((p) => ({ ...p, drafts: { ...p.drafts, [key]: text } }));
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(false);
        }}
        aria-label={`${id} ${lang}`}
        className="w-36 rounded border bg-transparent px-1 py-0.5 text-[12.5px] outline-none"
        style={{ borderColor: "var(--m3-primary)" }}
      />
    );
  }
  const shown = draft ?? (v.startsWith("!!!stale!!!") ? v.slice(11) : v);
  return (
    <button
      onClick={() => { setText(shown); setEditing(true); }}
      className="m3-focus text-left"
      title="Click to edit (local draft)"
      style={draft ? { boxShadow: "inset 0 -2px 0 var(--m3-tertiary)" } : undefined}
    >
      {v.startsWith("!!!stale!!!") && !draft ? <span><Pill tone="warn">stale</Pill> <span style={{ color: "var(--m3-on-surface-variant)" }}>{shown}</span></span> : shown}
      {draft ? <span style={{ color: "var(--m3-tertiary)" }}> ●</span> : null}
    </button>
  );
}

export function StringsPreview(): React.JSX.Element {
  const { row, drafts } = stringsStore.use();
  const draftCount = Object.keys(drafts).length;
  return (
    <div className="flex flex-col gap-2">
      <PreviewBadge slice="EA · Story (§7c.8)">String tables with pseudo-locale preview and extraction status.</PreviewBadge>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full px-4 py-1.5 text-sm" style={{ background: "var(--m3-surface-2)", color: "var(--m3-on-surface-variant)" }}>⌕ Filter strings</span>
        <Pill tone="plain">Missing · 41</Pill>
        <Pill tone="plain">Stale · 6</Pill>
        <Pill tone="plain">Over length · 3</Pill>
        {draftCount > 0 && <Pill tone="warn">{draftCount} draft{draftCount === 1 ? "" : "s"}</Pill>}
        <button
          onClick={() => notify("Add string — staged for EA · story (extraction picks it up from t())")}
          title="Add string (staged)"
          className="m3-focus flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
          style={{ background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }}
        >
          <MIcon name="add" size={15} />Add
        </button>
        <span className="ml-auto rounded-full px-4 py-1.5 text-sm" style={{ background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }}>文A Pseudo-locale</span>
      </div>
      <div className="overflow-x-auto rounded-xl" style={{ background: "var(--m3-surface-2)" }}>
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              {["id", "en · source", "fr", "de", "es"].map((h) => (
                <th key={h} className="whitespace-nowrap px-2 text-left font-medium" style={{ background: "var(--m3-surface-2)", color: "var(--m3-on-surface-variant)", height: 32 }}>{h}</th>
              ))}
              <th className="w-10" style={{ background: "var(--m3-surface-2)", height: 32 }}><span className="sr-only">Row actions</span></th>
            </tr>
          </thead>
          <tbody>
            {STRINGS.map(([id, en, fr, de, es]) => {
              const on = id === row;
              return (
                <tr
                  key={id}
                  onClick={() => stringsStore.set((p) => ({ ...p, row: id }))}
                  className="group cursor-pointer"
                  style={{ borderBottom: "1px solid #2a2b31", background: on ? "#2b2f4a" : undefined }}
                >
                  <td className="whitespace-nowrap px-2 font-mono text-xs" style={{ height: 30 }}>{id}</td>
                  <td className="whitespace-nowrap px-2" style={{ height: 30 }}>{en}</td>
                  <td className="px-2" style={{ height: 30 }} onClick={(e) => e.stopPropagation()}><StrCell id={id} lang="fr" v={fr} /></td>
                  <td className="px-2" style={{ height: 30 }} onClick={(e) => e.stopPropagation()}><StrCell id={id} lang="de" v={de} /></td>
                  <td className="px-2" style={{ height: 30 }} onClick={(e) => e.stopPropagation()}><StrCell id={id} lang="es" v={es} /></td>
                  <td className="px-1" style={{ height: 30 }} onClick={(e) => e.stopPropagation()}>
                    <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <OverflowMenu
                        label={`${id} actions`}
                        items={[
                          { label: "Reveal usages", icon: "search", stagedFor: "EA · story" },
                          "sep",
                          { label: "Rename id…", icon: "edit", stagedFor: "EA · story" },
                          { label: "Duplicate", icon: "content_copy", stagedFor: "EA · story" },
                          { label: "Delete string", icon: "delete", danger: true, stagedFor: "EA · story" },
                        ]}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
          <p className="mb-2 text-sm font-medium">Languages</p>
          <BarRow label="English · source" pct={100} text="100 %" bar="#9CD67D" />
          <BarRow label="Français" pct={88} text="88 %" bar="#B9C3FF" />
          <BarRow label="Deutsch" pct={97} text="97 %" bar="#9CD67D" />
          <BarRow label="Español" pct={71} text="71 %" bar="#B9C3FF" />
        </div>
        <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>In context · pseudo-locale</p>
          <div className="rounded-xl border p-3 text-[13px] leading-relaxed" style={{ borderColor: "#E8A33D", background: "#2b2417" }}>
            <p className="font-semibold" style={{ color: "#E8C33D" }}>Wärdëñ Hâlę</p>
            <p style={{ color: "var(--m3-on-surface-variant)" }}>[!!! Ģöblįñš țöök țhë öld wáțčhțöwër. Člëär țhëįr čâmp ëâšț öf héré âñd brįñĝ më prööf. !!!]</p>
          </div>
          <p className="mt-2 text-xs" style={{ color: "#E8A33D" }}>ⓘ hale.reply.ask clips in the reply button (+38 %)</p>
          <SectionLabel>Extraction</SectionLabel>
          <p className="text-xs" style={{ color: "#9CD67D" }}>✓ 302 client strings behind t()</p>
          <p className="text-xs" style={{ color: "#E8A33D" }}>⚠ 17 literals left in 4 files</p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- art & audio (ux-14, ux-15, ux-17)

export const CLIPS: Array<[string, string]> = [
  ["Idle_Loop", "UAL"], ["Walk_Fwd", "UAL"], ["Jog_Fwd", "UAL"], ["Jog_Strafe_L", "UAL"],
  ["Sprint_Fwd", "UAL"], ["Swim_Fwd", "UAL"], ["Sword_Slash_R", "KI"], ["Axe_Chop", "KI"],
  ["Block_Hold", "KI"], ["Hit_React_F", "CMU"], ["Death_Back", "CMU"],
];

const artStore = createStore<{ clip: string; effect: string; event: string }>({
  clip: "Jog_Fwd",
  effect: "campfire.embers",
  event: "hit.sword",
});

export { artStore };

export function ClipList(): React.JSX.Element {
  const { clip } = artStore.use();
  return (
    <div>
      <ul className="flex flex-col gap-0.5">
        {CLIPS.map(([c, tag]) => {
          const on = c === clip;
          return (
            <li key={c}>
              <button
                onClick={() => artStore.set((p) => ({ ...p, clip: c }))}
                className="m3-focus flex h-9 w-full items-center gap-2 rounded-full px-3 font-mono text-xs"
                style={on ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
              >
                <MIcon name="directions_run" size={16} />{c}
                <span className="ml-auto" style={{ color: "var(--m3-on-surface-variant)" }}>{tag}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <SectionLabel>Retarget</SectionLabel>
      <p className="px-1 font-mono text-[11px] leading-[1.9]" style={{ color: "var(--m3-on-surface-variant)" }}>
        source: Kevin Iglesias rig<br />target: Synty humanoid<br />✓ 41 bones mapped
      </p>
    </div>
  );
}

/** Left library for Art & audio: clips, effects, or events per active view. */
export function ArtAudioTree({ view }: { view: string }): React.JSX.Element {
  if (view === "animation") return <ClipList />;
  const { effect, event } = artStore.use();
  if (view === "vfx") {
    return (
      <ul className="flex flex-col gap-0.5">
        {EFFECTS.map(([e, tag]) => {
          const on = e === effect;
          return (
            <li key={e}>
              <button
                onClick={() => artStore.set((p) => ({ ...p, effect: e }))}
                className="m3-focus flex h-9 w-full items-center gap-2 rounded-full px-3 font-mono text-xs"
                style={on ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
              >
                <MIcon name="sparkles" size={15} />{e}
                <span className="ml-auto" style={{ color: "var(--m3-on-surface-variant)" }}>{tag}</span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }
  if (view === "audio") {
    return (
      <div>
        {AUDIO_EVENTS.map(([group, evts]) => (
          <div key={group} className="mb-1">
            <p className="px-2 py-1 font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>⌄ {group}</p>
            {evts.map(([e, n]) => {
              const on = e === event;
              return (
                <button
                  key={e}
                  onClick={() => artStore.set((p) => ({ ...p, event: e }))}
                  className="m3-focus flex h-8 w-full items-center gap-2 rounded-full px-2 pl-5 font-mono text-xs"
                  style={on ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
                >
                  <MIcon name="audio_file" size={15} />{e}
                  <span className="ml-auto" style={{ color: "var(--m3-on-surface-variant)" }}>{n}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {[["Art pack", "scanned"], ["Models", "38"], ["Textures", "112"], ["Audio", "24 clips"]].map(([l, t]) => (
        <li key={l} className="flex h-10 items-center gap-3 rounded-full px-3 text-sm" style={{ color: "var(--m3-on-surface)" }}>
          <span style={{ color: "var(--m3-on-surface-variant)" }}><MIcon name="folder" size={19} /></span>{l}
          <span className="ml-auto text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{t}</span>
        </li>
      ))}
    </ul>
  );
}

export function AnimDetails(): React.JSX.Element {
  const { clip } = artStore.use();
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
        CLIP · {clip.toUpperCase().replace(/_/g, " ")}
      </p>
      <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>
        Transition · Walk → Jog
      </p>
      <DraftField label="Condition" value="speed > 1.8" />
      <DraftField label="Crossfade" value="0.20 s" />
      <SectionLabel>Blend space · jog</SectionLabel>
      <svg viewBox="0 0 160 130" className="w-full rounded-xl" style={{ background: "var(--m3-surface-2)" }} aria-hidden="true">
        <line x1="80" y1="8" x2="80" y2="122" stroke="#46464F" />
        <line x1="8" y1="65" x2="152" y2="65" stroke="#46464F" />
        <circle cx="80" cy="18" r="5" fill="#B9C3FF" />
        <circle cx="30" cy="65" r="5" fill="#B9C3FF" />
        <circle cx="130" cy="65" r="5" fill="#B9C3FF" />
        <circle cx="80" cy="112" r="5" fill="#B9C3FF" />
        <circle cx="108" cy="44" r="8" fill="none" stroke="#FFB59A" strokeWidth="2" />
        <text x="90" y="20" fill="#C6C5D0" fontSize="9">fwd</text>
        <text x="4" y="60" fill="#C6C5D0" fontSize="9">strafe L</text>
        <text x="112" y="60" fill="#C6C5D0" fontSize="9">strafe R</text>
        <text x="70" y="124" fill="#C6C5D0" fontSize="9">back</text>
      </svg>
      <SectionLabel>Played on</SectionLabel>
      <div className="flex h-9 items-center overflow-hidden rounded-full text-sm" style={{ border: "1px solid var(--m3-outline-variant)" }}>
        {["Human F", "Human M", "Goblin"].map((m, i) => (
          <span key={m} className="flex h-full flex-1 items-center justify-center" style={i === 0 ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}>
            {m}
          </span>
        ))}
      </div>
    </div>
  );
}

export function AnimPreview(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <PreviewBadge slice="EA · Art & audio (§7c.4)">Clips, the locomotion state machine and the combat timeline.</PreviewBadge>
      <div className="flex flex-col gap-3">
          <svg viewBox="0 0 560 220" className="w-full rounded-xl" style={{ background: "var(--m3-surface-0)", backgroundImage: "radial-gradient(#2a2b31 1px, transparent 1px)", backgroundSize: "22px 22px" }} role="img" aria-label="Locomotion state machine preview">
            {[
              [30, 100, "Idle", "loop · 1.0×"], [200, 40, "Walk", "speed 0.2–1.8"], [200, 140, "Jog", "blend: strafe"],
              [380, 40, "Air", "mode = air"], [380, 140, "Sprint", "speed > 5.5"], [30, 180, "Swim", "mode = swim"],
            ].map(([x, y, t, s]) => (
              <g key={t as string}>
                <rect x={x as number} y={y as number} width="130" height="52" rx="10" fill={t === "Jog" ? "#36449A" : "#292A2F"} stroke={t === "Jog" ? "#B9C3FF" : "#46464F"} strokeWidth={t === "Jog" ? 2 : 1} />
                <text x={(x as number) + 12} y={(y as number) + 22} fill="#E3E1E9" fontSize="12" fontWeight="600">{t}</text>
                <text x={(x as number) + 12} y={(y as number) + 40} fill="#C6C5D0" fontSize="10" fontFamily="Roboto Mono, monospace">{s}</text>
              </g>
            ))}
            <path d="M160,110 C180,100 180,70 200,62" stroke="#90909A" fill="none" markerEnd="url(#ah2)" />
            <path d="M330,66 L380,66" stroke="#90909A" fill="none" markerEnd="url(#ah2)" />
            <path d="M265,92 L265,140" stroke="#90909A" fill="none" markerEnd="url(#ah2)" />
            <path d="M330,166 L380,166" stroke="#90909A" fill="none" markerEnd="url(#ah2)" />
            <defs>
              <marker id="ah2" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="#90909A" />
              </marker>
            </defs>
            <text x="168" y="92" fill="#C6C5D0" fontSize="10" fontFamily="Roboto Mono, monospace">0.15 s</text>
            <text x="272" y="120" fill="#C6C5D0" fontSize="10" fontFamily="Roboto Mono, monospace">0.2 s</text>
          </svg>
          <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
            <p className="mb-2 text-sm"><span className="font-mono font-semibold">sword.slash</span> <span className="font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>COMBAT_MOVES · 24 frames · 30 fps · server ticks shown</span></p>
            {[
              ["clip", 0, 24, "#434659", "Sword_Slash_R · retargeted Synty"],
              ["wind-up", 0, 8, "#5a3a1a", "wind-up 0–8"],
              ["hit", 12.5, 14, "#93000A", ""],
              ["cancel window", 16, 22, "#1F5110", "cancel 16–22"],
              ["root motion", 6, 15, "#3a3355", "travel 1.2 m"],
              ["sound", 12.5, 14.5, "#36449A", "hit.sword"],
              ["vfx", 11, 15, "#7A2E12", "trail.sword · hit.spark"],
              ["target reaction", 13, 18, "#434659", "Hit_React_F · CMU"],
              ["camera", 13, 14.5, "#1F5110", "shake 0.2"],
            ].map(([label, a, b, bg, text]) => (
              <div key={label as string} className="flex items-center gap-2" style={{ height: 30 }}>
                <span className="w-28 flex-none text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{label}</span>
                <div className="relative h-5 flex-1 rounded-md" style={{ background: "var(--m3-surface-1)" }}>
                  <span
                    className="absolute top-0 h-full overflow-hidden whitespace-nowrap rounded-md px-2 font-mono text-[11px] leading-5"
                    style={{ left: `${(a as number) / 24 * 100}%`, width: `${((b as number) - (a as number)) / 24 * 100}%`, background: bg as string, color: "#E3E1E9" }}
                  >
                    {text}
                  </span>
                </div>
              </div>
            ))}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <OutlinedField label="Condition" value="speed > 1.8" />
              <OutlinedField label="Crossfade" value="0.20 s" />
            </div>
            <p className="mt-2 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>Played on: Human F · Human M · Goblin · Blend space: jog (fwd / strafe L–R / back)</p>
          </div>
        </div>
      </div>
    );
  }

export const EFFECTS: Array<[string, string]> = [
  ["campfire.embers", "quarks"], ["weather.snow", "nebula"], ["weather.rain", "nebula"],
  ["element.storm", "orb"], ["aura.heal", "quarks"], ["trail.sword", "trail"], ["hit.spark", "quarks"],
];

export function VfxPreview(): React.JSX.Element {
  const { effect } = artStore.use();
  const dots = React.useMemo(() => {
    const r = rnd(1337);
    return Array.from({ length: 130 }, () => ({ x: 30 + r() * 240, y: 20 + Math.pow(r(), 1.6) * 250, s: 1 + r() * 3, o: 0.25 + r() * 0.75 }));
  }, []);
  return (
    <div className="flex flex-col gap-3">
      <PreviewBadge slice="EA · Art & audio (§7c.5)">Particles, materials, post and quality tiers with per-tier budgets.</PreviewBadge>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[200px_1fr_280px]">
        <div className="rounded-xl p-2" style={{ background: "var(--m3-surface-2)" }}>
          {EFFECTS.map(([e, tag]) => {
            const on = e === effect;
            return (
              <button
                key={e}
                onClick={() => artStore.set((p) => ({ ...p, effect: e }))}
                className="m3-focus flex h-9 w-full items-center gap-2 rounded-full px-3 font-mono text-xs"
                style={on ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
              >
                <MIcon name="sparkles" size={15} />{e}
                <span className="ml-auto" style={{ color: "var(--m3-on-surface-variant)" }}>{tag}</span>
              </button>
            );
          })}
          <SectionLabel>Materials</SectionLabel>
          {["toon.skin", "toon.cloth", "toon.metal", "surface.grass", "surface.rock"].map((m) => (
            <p key={m} className="flex h-8 items-center gap-2 px-3 font-mono text-xs" style={{ color: "var(--m3-on-surface)" }}>
              <MIcon name="palette" size={15} />{m}
            </p>
          ))}
        </div>
        <div className="flex flex-col gap-3">
          <div className="relative mx-auto w-full max-w-[420px] overflow-hidden rounded-xl" style={{ background: "#0a0a0e", aspectRatio: "4/5" }}>
            <svg viewBox="0 0 300 330" className="absolute inset-0 h-full w-full" aria-hidden="true">
              {dots.map((d, i) => (
                <circle key={i} cx={d.x} cy={d.y} r={d.s} fill={d.y > 220 ? "#FFE9D6" : d.y > 140 ? "#E8A37A" : "#8a4a2a"} opacity={d.o} />
              ))}
              <ellipse cx="150" cy="300" rx="70" ry="12" fill="#3d2417" opacity="0.8" />
            </svg>
            <div className="absolute bottom-2 left-3 right-3 flex items-center gap-2 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
              <MIcon name="play_arrow" size={16} />
              <div className="h-1 flex-1 rounded-full" style={{ background: "var(--m3-surface-4)" }}>
                <div className="h-full w-[42%] rounded-full" style={{ background: "var(--m3-primary)" }} />
              </div>
              <span className="font-mono">0.67 / 1.60 s</span>
            </div>
          </div>
          <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
            <p className="mb-2 font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>TOON.SKIN · RAMP</p>
            <div className="h-5 overflow-hidden rounded-md" style={{ background: "linear-gradient(90deg,#4a1f14,#8a4a2a 45%,#E8A37A 70%,#FFE9D6)" }} />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <OutlinedField label="Outline" value="1.6 px" />
              <OutlinedField label="Rim" value="0.35" />
              <OutlinedField label="Shadow step" value="0.52" />
              <OutlinedField label="Specular" value="off" />
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-2 rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
          <p className="font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
            EMITTER · {effect.split(".")[1]?.toUpperCase() ?? effect.toUpperCase()}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <OutlinedField label="Rate" value="80 /s" />
            <OutlinedField label="Life" value="1.6 s" />
            <OutlinedField label="Speed" value="0.8–2.4" />
            <OutlinedField label="Shape" value="cone 18°" />
          </div>
          <SectionLabel>Size over life</SectionLabel>
          <svg viewBox="0 0 200 60" className="w-full rounded-lg" style={{ background: "var(--m3-surface-1)" }} aria-hidden="true">
            <path d="M8,52 C60,50 70,10 110,14 C150,18 170,40 192,48" fill="none" stroke="#B9C3FF" strokeWidth="1.5" />
            <circle cx="110" cy="14" r="4" fill="#B9C3FF" />
          </svg>
          <SectionLabel>Colour over life</SectionLabel>
          <div className="h-4 rounded-full" style={{ background: "linear-gradient(90deg,#FFE9D6,#E8A37A,#8a4a2a)" }} />
          <SectionLabel>Budget per quality tier</SectionLabel>
          <BarRow label="low" pct={140} text="210 / 150" bar="#FFB4AB" />
          <BarRow label="medium" pct={52} text="210 / 400" bar="#9CD67D" />
          <BarRow label="high" pct={26} text="210 / 800" bar="#9CD67D" />
          <BarRow label="ultra" pct={13} text="210 / 1600" bar="#9CD67D" />
          <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>Low is over budget: lower the rate or drop to 60 % on low.</p>
          <SectionLabel>Signals</SectionLabel>
          {[["prefab: campfire", "attach"], ["night only", "time of day"], ["wind drift", "weather"]].map(([a, b]) => (
            <p key={a} className="flex text-xs"><span style={{ color: "var(--m3-on-surface)" }}>{a}</span><span className="ml-auto" style={{ color: "var(--m3-on-surface-variant)" }}>{b}</span></p>
          ))}
        </div>
      </div>
    </div>
  );
}

export const AUDIO_EVENTS: Array<[string, Array<[string, string]>]> = [
  ["combat", [["hit.sword", "4 clips"], ["hit.axe", "3 clips"], ["block.shield", "2 clips"], ["death.goblin", "2 clips"]]],
  ["movement", [["step.grass", "6 clips"], ["step.rock", "6 clips"], ["step.wood", "5 clips"]]],
  ["ambience", [["amb.coast.day", "loop"], ["amb.rain", "loop"]]],
  ["music", [["music.login", "stream"], ["music.coast", "stream"]]],
  ["ui", [["ui.click", "1 clip"]]],
];

function Waveform({ seed, bars = 72 }: { seed: number; bars?: number }): React.JSX.Element {
  const r = rnd(seed);
  const hs = Array.from({ length: bars }, (_, i) => {
    const env = Math.sin((i / bars) * Math.PI);
    return 2 + env * (2 + r() * 18);
  });
  return (
    <div className="flex h-9 flex-1 items-center gap-[2px]" aria-hidden="true">
      {hs.map((h, i) => (
        <span key={i} className="w-[2px] rounded-full" style={{ height: h, background: "#B9C3FF", opacity: 0.85 }} />
      ))}
    </div>
  );
}

export function AudioPreview(): React.JSX.Element {
  const { event } = artStore.use();
  return (
    <div className="flex flex-col gap-3">
      <PreviewBadge slice="EA · Art & audio (§7c.7)">Sound events, the mixer and 3D preview with per-event budgets.</PreviewBadge>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[200px_1fr_260px]">
        <div className="rounded-xl p-2" style={{ background: "var(--m3-surface-2)" }}>
          {AUDIO_EVENTS.map(([group, evts]) => (
            <div key={group} className="mb-1">
              <p className="px-2 py-1 font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>⌄ {group}</p>
              {evts.map(([e, n]) => {
                const on = e === event;
                return (
                  <button
                    key={e}
                    onClick={() => artStore.set((p) => ({ ...p, event: e }))}
                    className="m3-focus flex h-8 w-full items-center gap-2 rounded-full px-2 pl-5 font-mono text-xs"
                    style={on ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
                  >
                    <MIcon name="audio_file" size={15} />{e}
                    <span className="ml-auto" style={{ color: "var(--m3-on-surface-variant)" }}>{n}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-3">
          <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
            <p className="mb-2 text-sm"><strong>{event}</strong> <Pill tone="info">bus: effects</Pill> <Pill tone="ok">3D</Pill>
              <span className="float-right font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>content/audio/events.json</span>
            </p>
            {[["sword_hit_01.ogg", "0.42 s · /assets/audio", 11, "w 1"], ["sword_hit_02.ogg", "0.38 s · /assets/audio", 23, "w 1"], ["sword_hit_03.ogg", "0.51 s · /assets/audio", 37, "w 1"], ["sword_hit_heavy.ogg", "0.66 s · /assets/audio", 51, "w 0.3"]].map(([f, meta, seed, w]) => (
              <div key={f as string} className="mb-2 flex items-center gap-3 rounded-xl p-2" style={{ background: "var(--m3-surface-1)" }}>
                <MIcon name="play_circle" size={22} />
                <div className="w-44 flex-none">
                  <p className="font-mono text-xs">{f}</p>
                  <p className="font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>{meta}</p>
                </div>
                <Waveform seed={seed as number} />
                <span className="font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>{w}</span>
              </div>
            ))}
            <div className="mt-2 grid grid-cols-2 gap-2 xl:grid-cols-4">
              <OutlinedField label="Pitch" value="0.92–1.08" />
              <OutlinedField label="Volume" value="-3 to 0 dB" />
              <OutlinedField label="Max distance" value="28 m" />
              <OutlinedField label="Voices" value="6, steal oldest" />
            </div>
            <SectionLabel>Fired by</SectionLabel>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {["sword.slash · hit frame 13", "sword.heavy · hit frame 19", "combat: weapon class sword"].map((c) => (
                <span key={c} className="rounded-full border px-3 py-1.5" style={{ borderColor: "var(--m3-outline-variant)" }}>{c}</span>
              ))}
            </div>
          </div>
          <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
            <p className="mb-2 text-sm font-medium">Mixer</p>
            <div className="flex items-end justify-around" style={{ height: 150 }}>
              {[["Master", "0 dB", 62, false], ["Music", "-6 dB", 40, true], ["Effects", "-2 dB", 58, false], ["Voice", "0 dB", 52, false], ["Ambience", "-9 dB", 30, false], ["UI", "-4 dB", 12, false]].map(([name, db, h, ducked]) => (
                <div key={name as string} className="flex flex-col items-center gap-1">
                  <div className="relative w-2.5 rounded-full" style={{ height: 110, background: "var(--m3-surface-4)" }}>
                    <div className="absolute bottom-0 w-full rounded-full" style={{ height: `${h}%`, background: "linear-gradient(0deg,#9CD67D 70%,#E8A33D 85%,#FFB4AB)" }} />
                    <div className="absolute h-3 w-5 rounded-full" style={{ bottom: `${h}%`, left: -5, background: "#B9C3FF" }} />
                  </div>
                  <p className="text-xs">{name}</p>
                  <p className="font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>{db}</p>
                  {ducked ? <Pill tone="warn">ducked -6</Pill> : null}
                </div>
              ))}
            </div>
            <p className="mt-2 text-center text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>Music ducks under dialog voice by 6 dB · 0.3 s attack</p>
          </div>
        </div>
        <div className="flex flex-col gap-2 rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
          <p className="text-sm font-medium">3D preview</p>
          <svg viewBox="0 0 200 200" className="w-full rounded-xl" style={{ background: "var(--m3-surface-1)" }} role="img" aria-label="3D attenuation preview">
            {[85, 60, 35].map((r) => (
              <circle key={r} cx="100" cy="100" r={r} fill="none" stroke="#46464F" strokeWidth="1" strokeDasharray={r === 85 ? "4 4" : "none"} />
            ))}
            <circle cx="100" cy="100" r="8" fill="#FFB59A" />
            <text x="112" y="104" fill="#FFB59A" fontSize="10" fontFamily="Roboto Mono, monospace">{event}</text>
            <text x="150" y="52" fill="#C6C5D0" fontSize="10" fontFamily="Roboto Mono, monospace">listener ▶</text>
          </svg>
          <p className="text-center font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>28 m · -9.4 dB · pan R 0.38</p>
          <SectionLabel>Hooks</SectionLabel>
          {["footsteps by surface (6 surfaces)", "ambience by weather and time of day", "music by game-flow scene"].map((h) => (
            <p key={h} className="text-[12.5px]" style={{ color: "var(--m3-on-surface)" }}>{h}</p>
          ))}
          <SectionLabel>Last plays in play mode</SectionLabel>
          <MiniTable
            mono
            crud="EA · art & audio"
            head={["Tick", "Clip", "Source", "Distance", "Gain"]}
            rows={[
              ["18,402", "sword_hit_02", "Aria → goblin 41", "3.1 m", "-1.2 dB"],
              ["18,391", "sword_hit_01", "Bram → wolf 7", "12.4 m", "-6.8 dB"],
              ["18,377", "sword_hit_heavy", "Aria → goblin 41", "3.0 m", "-0.9 dB"],
              ["18,360", "sword_hit_03", "Cass → goblin 12", "26.0 m", "-17 dB · culled"],
            ]}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- release (ux-12, ux-19)

const PIPE_STEPS: Array<[string, Tone, string, string]> = [
  ["Codegen", "ok", "cached", "0.2 s · FlatBuffers unchanged"],
  ["Build", "ok", "passed", "41 s · 18 workspaces"],
  ["Bakes", "ok", "passed", "12 s · world cached · dungeon 9 s · loot 3 s"],
  ["Tests", "ok", "passed", "1 m 52 s · 1,284 passed · 4 known red"],
  ["Valgrind", "ok", "passed", "3 m 10 s · memcheck clean · perf +0.4 %"],
  ["Package", "ok", "passed", "9 s · 182 MB · manifest"],
  ["Deploy", "warn", "waiting", "– · needs confirmation"],
];

export function PipelinePreview(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <PreviewBadge slice="EA · Release (§7c.2)">Build profiles, the pipeline, packages, deploy targets and rollback.</PreviewBadge>
      <p className="text-sm"><strong className="text-base">staging</strong> <span className="font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>profile · commit a81c3e0 · started 14:02</span>
        <span className="float-right rounded-full border px-3 py-1 text-xs" style={{ borderColor: "var(--m3-outline-variant)" }}>⚡ 6 of 9 steps cached</span>
      </p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
        {PIPE_STEPS.map(([name, tone, status, detail]) => (
          <div key={name} className="rounded-xl p-2.5" style={{ background: "var(--m3-surface-2)", border: name === "Deploy" ? "1.5px solid var(--m3-primary)" : "none" }}>
            <p className="mb-1 text-sm font-medium">{name}</p>
            <Pill tone={tone}>{status}</Pill>
            <p className="mt-1.5 font-mono text-[11px] leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>{detail}</p>
          </div>
        ))}
      </div>
      <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>Pipeline time · last 12 runs</p>
        <Chart points={[9.1, 9.6, 7.2, 7.1, 11.4, 8.0, 7.8, 7.9, 8.2, 8.0, 8.1, 8.2]} color="#B9C3FF" height={90} />
      </div>
      <div className="overflow-x-auto rounded-xl" style={{ background: "var(--m3-surface-2)" }}>
        <div className="p-3 pb-0 text-sm font-medium">Runs</div>
        <MiniTable
          mono
          crud="EA · release"
          head={["Run", "Profile", "Commit", "Steps", "Time", "Result"]}
          rows={[
            ["#214", "staging", "a81c3e0", "9 · 6 cached", "6 m 12 s", <Pill tone="warn">waiting</Pill>],
            ["#213", "local-dev", "9e07bd2", "7 · 5 cached", "2 m 40 s", <Pill tone="ok">passed</Pill>],
            ["#212", "perf-check", "4d22f10", "5 · 2 cached", "4 m 02 s", <Pill tone="ok">passed</Pill>],
            ["#211", "staging", "77b0c91", "9 · 4 cached", "6 m 51 s", <Pill tone="info">deployed</Pill>],
            ["#210", "local-dev", "1c9e4aa", "7 · 6 cached", "1 m 58 s", <Pill tone="err">failed</Pill>],
          ]}
        />
      </div>
      <div className="rounded-xl p-3 font-mono text-xs leading-[1.9]" style={{ background: "var(--m3-surface-0)", color: "var(--m3-on-surface-variant)" }}>
        <p><span style={{ color: "#7aa2ff" }}>14:02:01</span> codegen: inputs hash 7c19e2 unchanged, skipped</p>
        <p><span style={{ color: "#7aa2ff" }}>14:02:42</span> build: 18 workspaces in 41.3 s</p>
        <p><span style={{ color: "#7aa2ff" }}>14:04:44</span> test: 1,284 passed, 4 failed (known: gateway close code 1009, tracked)</p>
        <p><span style={{ color: "#7aa2ff" }}>14:07:54</span> valgrind:perf: tick +0.4 % vs baseline (threshold 3 %)</p>
        <p><span style={{ color: "#7aa2ff" }}>14:08:03</span> package: nexus-0.15.0-a81c3e0.tar.zst, 182 MB, no /assets/ files (private target only)</p>
        <p><span style={{ color: "#7aa2ff" }}>14:08:03</span> deploy staging: waiting for confirmation</p>
      </div>
    </div>
  );
}

export function ReleaseDeployDetails(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
        <p className="text-sm font-semibold">Deploy to staging?</p>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
          Changes since the last deploy (0.14.2, yesterday 18:40):<br />
          ⇢ 14 commits, 3 authors<br />
          ▤ creatures, loot tables changed<br />
          ⚙ module goblin-ai added<br />
          ⚙ MMO_BOTS 20 → 40
        </p>
        <div className="mt-2 flex gap-2">
          <span className="rounded-full px-4 py-1.5 text-sm" style={{ color: "var(--m3-primary)" }}>Cancel</span>
          <span className="rounded-full px-4 py-1.5 text-sm font-semibold" style={{ background: "var(--m3-primary)", color: "var(--m3-on-primary)" }}>🚀 Deploy</span>
        </div>
      </div>
      <SectionLabel>Targets</SectionLabel>
      {[["local", "0.15.0 · running"], ["staging", "0.14.2 · up 22 h"], ["public-alpha", "0.14.0 · 31 players"]].map(([t, s]) => (
        <p key={t} className="flex items-center text-[13px]">
          <span>{t}<br /><span className="font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>{s}</span></span>
          <span className="ml-auto"><Pill tone="ok">healthy</Pill></span>
        </p>
      ))}
      <SectionLabel>Rollback · staging</SectionLabel>
      {[["0.14.2", "yesterday"], ["0.14.1", "Sep 30"], ["0.14.0", "Sep 28"]].map(([v, d]) => (
        <p key={v} className="flex font-mono text-xs"><span>◷ {v}</span><span className="ml-auto" style={{ color: "var(--m3-on-surface-variant)" }}>{d}</span></p>
      ))}
    </div>
  );
}

const releaseStore = createStore<{ scenario: string }>({ scenario: "camp-loop" });

export { releaseStore };

export function PlaytestPreview(): React.JSX.Element {
  const { scenario } = releaseStore.use();
  const scen = scenario;
  const trail = "M40,120 C90,60 120,140 170,90 S260,40 320,80 S420,150 480,110 S560,60 640,100";
  return (
    <div className="flex flex-col gap-3">
      <PreviewBadge slice="EA · Release (§7c.9)">Playtest scenarios, replays and results with assertions.</PreviewBadge>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[210px_1fr_250px]">
        <div className="rounded-xl p-2" style={{ background: "var(--m3-surface-2)" }}>
          {[
            ["camp-loop", "12 bots · 200 s · arena-01", "failed"],
            ["coast-quest", "4 bots · warden-hale", "passed"],
            ["stress-200", "200 bots × 120 goblins", "passed"],
            ["ledger-soak", "loot and trade · 30 min", "passed"],
            ["login-flow", "8 clients · flow", "passed"],
            ["dungeon-run", "party of 5 · D4", "blocked"],
          ].map(([s, d, st]) => {
            const on = s === scen;
            return (
              <div
                key={s as string}
                className="group flex items-center gap-0.5 rounded-xl px-1 py-0.5"
                style={on ? { background: "var(--m3-secondary-container)" } : undefined}
              >
                <button
                  onClick={() => releaseStore.set({ scenario: s as string })}
                  className="m3-focus min-w-0 flex-1 rounded-xl px-2 py-1.5 text-left"
                >
                  <span className="flex items-center font-mono text-xs font-semibold">{s}<span className="ml-auto"><Pill tone={st === "passed" ? "ok" : st === "failed" ? "err" : "warn"}>{st as string}</Pill></span></span>
                  <span className="font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>{d}</span>
                </button>
                <span className="flex-none opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <OverflowMenu
                    label={`${s} actions`}
                    items={[
                      { label: `Inspect ${s}`, icon: "search", run: () => releaseStore.set({ scenario: s as string }) },
                      { label: "Run scenario", icon: "play_arrow", stagedFor: "EA · release" },
                      "sep",
                      { label: "Duplicate", icon: "content_copy", stagedFor: "EA · release" },
                      { label: "Delete", icon: "delete", danger: true, stagedFor: "EA · release" },
                    ]}
                  />
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex flex-col gap-3">
          <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
            <svg viewBox="0 0 700 300" className="w-full rounded-xl" style={{ background: "#14241a" }} role="img" aria-label="Replay map preview">
              {[40, 110, 180, 250].map((y) => (
                <line key={y} x1="0" y1={y} x2="700" y2={y} stroke="#243528" strokeWidth="1" />
              ))}
              <path d={trail} fill="none" stroke="#7d8aa8" strokeWidth="1.5" opacity="0.9" />
              <circle cx="420" cy="118" r="5" fill="#FFB59A" />
              <circle cx="470" cy="150" r="4" fill="#E8A33D" />
              <circle cx="250" cy="90" r="4" fill="#B9C3FF" />
              <rect x="430" y="130" width="90" height="46" rx="6" fill="none" stroke="#E8A33D" strokeDasharray="5 4" />
              <text x="424" y="120" fill="#FFB59A" fontSize="11" fontFamily="Roboto Mono, monospace">bot 7 · stuck 12 s</text>
              <text x="436" y="192" fill="#E8A33D" fontSize="11" fontFamily="Roboto Mono, monospace">goblin camp</text>
              <path d="M0,250 C150,230 300,270 450,250 S620,230 700,250 L700,300 L0,300 Z" fill="#2b4d7a" />
            </svg>
            <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
              <MIcon name="skip_previous" size={16} /><MIcon name="play_arrow" size={16} /><MIcon name="skip_next" size={16} />
              <div className="h-1.5 flex-1 rounded-full" style={{ background: "var(--m3-surface-4)" }}>
                <div className="h-full w-[80%] rounded-full" style={{ background: "var(--m3-primary)" }} />
              </div>
              <span className="font-mono">tick 4,812 / 6,000</span>
            </div>
            <p className="mt-2 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: "#93000A", color: "#FFDAD6" }}>
              ⓘ Assertion failed at tick 4,812: bot 7 stuck for 12 s at 431,0,188 (limit 8 s). Replay saved: camp-loop-a81c3e0.replay
            </p>
          </div>
          <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
            <p className="mb-2 text-sm font-medium">Assertions</p>
            <MiniTable
              mono
              crud="EA · release"
              head={["Assertion", "Limit", "Worst", ""]}
              rows={[
                ["tick p99", "< 20 ms", "11.4 ms", <Pill tone="ok">ok</Pill>],
                ["bot stuck", "< 8 s", "12 s", <Pill tone="err">failed</Pill>],
                ["ledger invariant", "holds", "holds", <Pill tone="ok">ok</Pill>],
                ["quest completes", "4 of 4", "4 of 4", <Pill tone="ok">ok</Pill>],
                ["memory growth", "< 5 %", "1.8 %", <Pill tone="ok">ok</Pill>],
              ]}
            />
          </div>
        </div>
        <div className="flex flex-col gap-2 rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
          <p className="font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>TICK P99 · CAMP-LOOP · LAST 12 COMMITS</p>
          <Chart points={[9.4, 9.8, 9.2, 9.6, 10.1, 10.4, 10.2, 10.8, 11.0, 11.1, 11.3, 11.4]} color="#B9C3FF" height={80} />
          <SectionLabel>Runs</SectionLabel>
          {[["a81c3e0", "14:09", "failed"], ["9e07bd2", "13:31", "passed"], ["4d22f10", "12:58", "passed"], ["77b0c91", "10:40", "passed"]].map(([c, t, s]) => (
            <p key={c} className="flex font-mono text-xs"><span>{c} · {t}</span><span className="ml-auto"><Pill tone={s === "passed" ? "ok" : "err"}>{s}</Pill></span></p>
          ))}
          <SectionLabel>Pass rate · all scenarios</SectionLabel>
          <Chart points={[100, 100, 83, 100, 100, 100, 83, 100, 100, 100, 100, 83]} color="#9CD67D" height={70} />
          <SectionLabel>Client capture</SectionLabel>
          <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>📷 24 screenshots · 1 GIF<br />▤ headless Chromium · medium tier</p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- flow graph (§6 scenes)

const FLOW_SCREENS: Record<string, { title: string; route: string; kind: string; header: string; guards: string[]; x: number; y: number }> = {
  boot: { title: "Boot", route: "—", kind: "entry", header: "#36449A", guards: ["client version ok", "content pack hash matches"], x: 12, y: 40 },
  login: { title: "Login", route: "/login", kind: "auth", header: "#6b4d9e", guards: ["session token", "edge reachable"], x: 226, y: 40 },
  register: { title: "Register", route: "/register", kind: "auth", header: "#6b4d9e", guards: ["invite code if required"], x: 226, y: 196 },
  select: { title: "Characters", route: "/characters", kind: "select", header: "#1F6F8B", guards: ["≥ 1 character"], x: 458, y: 40 },
  creator: { title: "Creator", route: "/characters/new", kind: "select", header: "#1F6F8B", guards: ["name available", "starter kit valid"], x: 458, y: 196 },
  world: { title: "World", route: "/world/:id", kind: "world", header: "#1F5110", guards: ["spawn ticket", "chunk stream open"], x: 690, y: 40 },
  respawn: { title: "Respawn", route: "overlay", kind: "system", header: "#5a3a1a", guards: ["death acknowledged"], x: 690, y: 196 },
};

const FLOW_EDGES: Array<{ from: string; to: string; label: string; dashed?: boolean; up?: boolean }> = [
  { from: "boot", to: "login", label: "config ok" },
  { from: "login", to: "select", label: "auth ok" },
  { from: "login", to: "register", label: "no account" },
  { from: "register", to: "login", label: "created", up: true },
  { from: "select", to: "world", label: "enter" },
  { from: "select", to: "creator", label: "create" },
  { from: "creator", to: "select", label: "saved", up: true },
  { from: "world", to: "respawn", label: "death" },
  { from: "respawn", to: "world", label: "ticket", up: true },
  { from: "world", to: "login", label: "logout", dashed: true },
];

function flowReachable(edges: FlowEdgeView[]): { count: number; total: number } {
  const seen = new Set<string>(["boot"]);
  const queue = ["boot"];
  while (queue.length > 0) {
    const cur = queue.pop() as string;
    for (const e of edges) {
      if (e.from === cur && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
  }
  return { count: seen.size, total: Object.keys(FLOW_SCREENS).length };
}

export interface FlowEdgeDraft {
  id: number;
  from: string;
  to: string;
  label: string;
}

export interface FlowEdgeView {
  from: string;
  to: string;
  label: string;
  dashed?: boolean;
  up?: boolean;
  /** index into FLOW_EDGES when this is a shipped edge */
  shipped?: number;
  /** id when this is a local draft edge */
  draft?: number;
}

const flowStore = createStore<{
  screen: string;
  drafts: FlowEdgeDraft[];
  removed: number[];
  connectFrom: string | null;
  seq: number;
}>({ screen: "world", drafts: [], removed: [], connectFrom: null, seq: 1 });

export { flowStore };

export function selectFlowScreen(screen: string): void {
  if (FLOW_SCREENS[screen]) flowStore.set((p) => ({ ...p, screen }));
}

/** Shipped edges minus locally-removed, plus local drafts. */
export function getFlowEdges(): FlowEdgeView[] {
  const { drafts, removed } = flowStore.get();
  const kept = FLOW_EDGES.flatMap((e, i) =>
    removed.includes(i) ? [] : [{ ...e, shipped: i }],
  );
  return [...kept, ...drafts.map((d) => ({ from: d.from, to: d.to, label: d.label, dashed: true, draft: d.id }))];
}

export function flowDraftCount(): number {
  const { drafts, removed } = flowStore.get();
  return drafts.length + removed.length;
}

export function startFlowConnect(from: string): void {
  if (!FLOW_SCREENS[from]) return;
  flowStore.set((p) => ({ ...p, screen: from, connectFrom: from }));
  notify(`Connecting from ${FLOW_SCREENS[from].title} — click a target screen, Esc cancels`);
}

export function cancelFlowConnect(): void {
  flowStore.set((p) => ({ ...p, connectFrom: null }));
}

export function completeFlowConnect(to: string): void {
  const { connectFrom } = flowStore.get();
  if (!connectFrom || !FLOW_SCREENS[to]) return;
  if (to === connectFrom) {
    notify("A screen cannot transition to itself — pick another target");
    return;
  }
  const exists = getFlowEdges().some((e) => e.from === connectFrom && e.to === to);
  if (exists) {
    notify(`${FLOW_SCREENS[connectFrom].title} → ${FLOW_SCREENS[to].title} already exists`);
    flowStore.set((p) => ({ ...p, connectFrom: null }));
    return;
  }
  const from = connectFrom;
  flowStore.set((p) => ({
    ...p,
    connectFrom: null,
    screen: to,
    seq: p.seq + 1,
    drafts: [...p.drafts, { id: p.seq, from, to, label: `to ${FLOW_SCREENS[to].title.toLowerCase()}` }],
  }));
  notify(`Draft transition ${FLOW_SCREENS[from].title} → ${FLOW_SCREENS[to].title} — local, ships with the scenes slice`);
}

export function removeFlowEdge(shipped: number): void {
  const e = FLOW_EDGES[shipped];
  flowStore.set((p) => (p.removed.includes(shipped) ? p : { ...p, removed: [...p.removed, shipped] }));
  if (e) notify(`Removed ${FLOW_SCREENS[e.from].title} → ${FLOW_SCREENS[e.to].title} locally — Reset document restores it`);
}

export function deleteFlowDraft(id: number): void {
  flowStore.set((p) => ({ ...p, drafts: p.drafts.filter((d) => d.id !== id) }));
}

export function renameFlowDraft(id: number, label: string): void {
  flowStore.set((p) => ({ ...p, drafts: p.drafts.map((d) => (d.id === id ? { ...d, label } : d)) }));
}

export function resetFlowDrafts(): void {
  flowStore.set((p) => ({ ...p, drafts: [], removed: [] }));
  notify("Flow document reset to the shipped version");
}

function FlowNode({ id }: { id: string }): React.JSX.Element {
  const { screen, connectFrom } = flowStore.use();
  const s = FLOW_SCREENS[id];
  const selected = screen === id;
  const source = connectFrom === id;
  const w = 168;
  const h = 52 + s.guards.length * 18;
  const oy = s.y + 26;
  const grab = (ev: React.MouseEvent): void => {
    ev.stopPropagation();
    if (connectFrom === id) cancelFlowConnect();
    else startFlowConnect(id);
  };
  return (
    <g
      onClick={() => {
        if (connectFrom) completeFlowConnect(id);
        else selectFlowScreen(id);
      }}
      style={{ cursor: connectFrom ? "crosshair" : "pointer" }}
    >
      <title>{connectFrom ? `Connect ${FLOW_SCREENS[connectFrom].title} → ${s.title}` : `${s.title} — click to inspect`}</title>
      <rect x={s.x} y={s.y} width={w} height={h} rx="10" fill="#1E1F25" stroke={source ? "#E8C33D" : selected ? "#B9C3FF" : "#46464F"} strokeWidth={source || selected ? 2 : 1} />
      <rect x={s.x} y={s.y} width={w} height="28" rx="10" fill={s.header} />
      <rect x={s.x} y={s.y + 18} width={w} height="14" fill={s.header} />
      <text x={s.x + 9} y={s.y + 19} fill="#E3E1E9" fontSize="12" fontWeight="600">{s.title}</text>
      <text x={s.x + 9} y={s.y + 44} fill="#90909A" fontSize="10" fontFamily="Roboto Mono, monospace">{s.route} · {s.kind}</text>
      {s.guards.map((g, i) => (
        <text key={i} x={s.x + 9} y={s.y + 62 + i * 18} fill={selected ? "#E3E1E9" : "#C6C5D0"} fontSize="10" fontFamily="Roboto Mono, monospace">✓ {g}</text>
      ))}
      {/* input port (left) — click completes a pending connection here */}
      <circle
        cx={s.x}
        cy={oy}
        r={14}
        fill="transparent"
        style={{ cursor: "crosshair" }}
        onClick={(ev) => {
          ev.stopPropagation();
          if (connectFrom) completeFlowConnect(id);
          else selectFlowScreen(id);
        }}
      >
        <title>{connectFrom ? `Connect here → ${s.title}` : `${s.title} input — start from another node's output port`}</title>
      </circle>
      <circle
        cx={s.x}
        cy={oy}
        r={connectFrom && connectFrom !== id ? 8 : 6}
        fill={connectFrom && connectFrom !== id ? "#E8C33D" : "#1E1F25"}
        stroke={connectFrom && connectFrom !== id ? "#E8C33D" : "#90909A"}
        strokeWidth="1.5"
        pointerEvents="none"
      />
      {/* output port (right) — click to start a connection from here */}
      <circle
        cx={s.x + w}
        cy={oy}
        r={14}
        fill="transparent"
        style={{ cursor: "crosshair" }}
        onClick={grab}
      >
        <title>{source ? "Cancel connection" : `Connect from ${s.title} — then click a target`}</title>
      </circle>
      <circle
        cx={s.x + w}
        cy={oy}
        r={source ? 8 : 6}
        fill={source ? "#E8C33D" : "#1E1F25"}
        stroke={source ? "#E8C33D" : "#90909A"}
        strokeWidth={source ? 2.5 : 1.5}
        pointerEvents="none"
      />
      {source && (
        <text x={s.x + w + 12} y={oy + 4} fill="#E8C33D" fontSize="10" fontFamily="Roboto Mono, monospace">from here…</text>
      )}
    </g>
  );
}

function edgePath(e: FlowEdgeView): string {
  const a = FLOW_SCREENS[e.from];
  const b = FLOW_SCREENS[e.to];
  if (e.up) {
    const x1 = a.x + 24;
    const x2 = b.x + 24;
    const y1 = a.y;
    const y2 = b.y + 52 + b.guards.length * 18;
    return `M${x1},${y1} C${x1},${y1 - 34} ${x2},${y2 + 34} ${x2},${y2}`;
  }
  if (a.y === b.y) {
    const x1 = a.x + 168;
    const y = a.y + 26;
    const x2 = b.x;
    if (e.dashed && !e.draft) return `M${x1},${y} C${x1},${-34} ${x2},${-34} ${x2},${14}`;
    if (e.dashed) return `M${x1},${y} C${x1 + 40},${y} ${x2 - 30},${y} ${x2},${y}`;
    const mx = (x1 + x2) / 2;
    return `M${x1},${y} C${mx},${y} ${mx},${y} ${x2},${y}`;
  }
  if (a.x === b.x) {
    if (a.y < b.y) {
      const x = a.x + 40;
      const y1 = a.y + 52 + a.guards.length * 18;
      return `M${x},${y1} L${x},${b.y}`;
    }
    // draft edge back up the same column
    const x1 = a.x + 24;
    const x2 = b.x + 24;
    const y1 = a.y;
    const y2 = b.y + 52 + b.guards.length * 18;
    return `M${x1},${y1} C${x1},${y1 - 34} ${x2},${y2 + 34} ${x2},${y2}`;
  }
  // draft diagonal across columns: right edge of source to top of target
  const x1 = a.x + 168;
  const y1 = a.y + 26;
  const x2 = b.x + 84;
  const y2 = b.y;
  return `M${x1},${y1} C${x1 + 44},${y1} ${x2},${y2 - 44} ${x2},${y2}`;
}

function edgeLabel(e: FlowEdgeView): { x: number; y: number } {
  const a = FLOW_SCREENS[e.from];
  const b = FLOW_SCREENS[e.to];
  if (e.up) return { x: a.x + 30, y: (a.y + b.y) / 2 + 40 };
  if (a.y === b.y && !e.dashed) return { x: (a.x + 168 + b.x) / 2, y: a.y + 14 };
  if (e.dashed && !e.draft) return { x: (a.x + b.x) / 2 + 40, y: -22 };
  if (a.x === b.x) return { x: a.x + 48, y: (a.y + b.y) / 2 + 60 };
  return { x: (a.x + 168 + b.x + 84) / 2 - 24, y: (a.y + b.y) / 2 - 6 };
}

export function FlowGraphPreview(): React.JSX.Element {
  const { screen, connectFrom } = flowStore.use();
  const [zoom, setZoom] = React.useState(1);
  const edges = getFlowEdges();
  const drafts = flowDraftCount();
  const reach = flowReachable(edges);
  const backToLogin = (() => {
    const seen = new Set<string>(["login"]);
    const queue = ["login"];
    while (queue.length > 0) {
      const cur = queue.pop() as string;
      for (const e of edges) {
        if (e.to === cur && !seen.has(e.from)) { seen.add(e.from); queue.push(e.from); }
      }
    }
    return { count: seen.size, total: Object.keys(FLOW_SCREENS).length };
  })();
  const W = Math.round(880 * zoom);
  const H = Math.round(400 * zoom);
  React.useEffect(() => {
    if (!connectFrom) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") cancelFlowConnect();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [connectFrom]);
  return (
    <div className="flex flex-col gap-3">
      <PreviewBadge slice="EA · scenes (§6)">Login → character → world as a validated document; the client runs today's hard-coded screens until the scenes slice lands.</PreviewBadge>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-mono" style={{ color: "var(--m3-on-surface-variant)" }}>content/scenes/login-to-world.flow.json</span>
        <Pill tone="info">7 screens · {edges.length} transitions</Pill>
        {drafts > 0 && <Pill tone="warn">◈ {drafts} local draft{ drafts === 1 ? "" : "s"}</Pill>}
        <span className="ml-auto flex items-center gap-1">
          <IconButton label="Zoom out" size={36} onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))}><MIcon name="remove" size={19} /></IconButton>
          <span className="w-12 text-center font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{Math.round(zoom * 100)}%</span>
          <IconButton label="Zoom in" size={36} onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))}><MIcon name="add" size={19} /></IconButton>
          <IconButton label="Reset view" size={36} onClick={() => setZoom(1)}><MIcon name="fit_screen" size={19} /></IconButton>
          {drafts > 0 && (
            <IconButton label="Reset document to the shipped version" size={36} onClick={resetFlowDrafts}><MIcon name="restart_alt" size={19} /></IconButton>
          )}
          <button
            onClick={() => staged("Add screen", "EA · scenes (§6)")}
            className="m3-focus ml-1 flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium"
            style={{ background: "var(--m3-primary)", color: "var(--m3-on-primary)" }}
          >
            <MIcon name="add" size={18} /> Screen
          </button>
        </span>
      </div>
      {connectFrom && (
        <div className="flex items-center gap-2 rounded-xl px-3 py-2 text-[13px]" style={{ background: "rgba(232,163,61,.14)", color: "#E8A33D" }}>
          <MIcon name="cable" size={18} />
          <span>Connecting from <strong>{FLOW_SCREENS[connectFrom].title}</strong> — click a node's input port or body. Port on the right starts over.</span>
          <button onClick={cancelFlowConnect} className="m3-focus ml-auto rounded-full px-3 py-1 font-medium" style={{ border: "1px solid #E8A33D" }}>Cancel (Esc)</button>
        </div>
      )}
      <div className="m3-scroll overflow-auto rounded-xl" style={{ height: 440, background: "var(--m3-surface-0)" }}>
      <svg
        width={W}
        height={H}
        className="block rounded-xl"
        style={{ minWidth: "100%", backgroundImage: "radial-gradient(#2a2b31 1px, transparent 1px)", backgroundSize: "22px 22px" }}
        role="img"
        aria-label="Screen flow graph preview"
      >
        <defs>
          <marker id="ah-flow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="#90909A" />
          </marker>
        </defs>
        <g transform={`translate(0,${40 * zoom}) scale(${zoom})`}>
          {edges.map((e) => {
            const lp = edgeLabel(e);
            const custom = e.draft !== undefined;
            const centered = !custom && !e.dashed && FLOW_SCREENS[e.from].y === FLOW_SCREENS[e.to].y;
            return (
              <g key={custom ? `d${e.draft}` : `s${e.shipped}`} opacity={connectFrom ? 0.45 : 1}>
                <path
                  d={edgePath(e)}
                  stroke={custom ? "#B9C3FF" : "#90909A"}
                  strokeWidth={custom ? 2 : 1.5}
                  strokeDasharray={e.dashed ? "5 4" : undefined}
                  fill="none"
                  markerEnd="url(#ah-flow)"
                />
                <text x={lp.x} y={lp.y} textAnchor={centered ? "middle" : undefined} fill={custom ? "#B9C3FF" : "#C6C5D0"} fontSize="10" fontFamily="Roboto Mono, monospace">
                  {custom ? `◈ ${e.label}` : e.label}</text>
              </g>
            );
          })}
          {Object.keys(FLOW_SCREENS).map((id) => <FlowNode key={id} id={id} />)}
        </g>
      </svg>
      </div>
      <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
        <p className="mb-2 text-sm font-medium">Validation <span className="font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>· computed locally from this document</span></p>
        <MiniTable
          head={["", "Check", "Result"]}
          rows={[
            [reach.count === reach.total ? "✓" : "⚠", "All screens reachable from boot", <span className="font-mono">{reach.count} / {reach.total}</span>],
            [backToLogin.count === backToLogin.total ? "✓" : "⚠", "Every screen has a way back to login", <span className="font-mono">{backToLogin.count} / {backToLogin.total}</span>],
            ["✓", "Selected screen guards listed", <span className="font-mono">{FLOW_SCREENS[screen].guards.length} guards · {screen}</span>],
            ...(drafts > 0 ? [[
              "◈",
              "Local draft transitions (reset restores shipped)",
              <span key="d" className="font-mono">{drafts} pending</span>,
            ]] : []),
          ]}
        />
      </div>
    </div>
  );
}

export function FlowDetails(): React.JSX.Element {
  const { screen, connectFrom } = flowStore.use();
  const s = FLOW_SCREENS[screen];
  const edges = getFlowEdges();
  const outs = edges.filter((e) => e.from === screen);
  const ins = edges.filter((e) => e.to === screen);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">
        <span style={{ color: "var(--m3-on-surface-variant)" }}>Screen · </span>{s.title}
      </p>
      <DraftField label="route" value={s.route} mono />
      <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>kind · {s.kind} · owning slice scenes (§6)</p>
      <button
        onClick={() => (connectFrom === screen ? cancelFlowConnect() : startFlowConnect(screen))}
        className="m3-focus mt-1 flex h-9 items-center justify-center gap-1.5 rounded-full text-[13px] font-medium"
        style={connectFrom === screen
          ? { border: "1px solid #E8A33D", color: "#E8A33D" }
          : { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }}
      >
        <MIcon name="cable" size={18} />{connectFrom === screen ? "Cancel connection" : "Connect from here"}
      </button>
      <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>Entry guards</p>
      {s.guards.map((g, i) => (
        <DraftField key={`${screen}-g${i}`} label={`guard ${i + 1}`} value={g} mono />
      ))}
      <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>Transitions in</p>
      {ins.map((e) => (
        <button key={e.draft !== undefined ? `d${e.draft}` : `s${e.shipped}`} onClick={() => selectFlowScreen(e.from)} className="m3-focus flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-white/5">
          <MIcon name="login" size={16} /><span className="font-mono text-xs">{FLOW_SCREENS[e.from].title}</span>
          <span style={{ color: "var(--m3-on-surface-variant)" }}>→ {e.draft !== undefined ? `◈ ${e.label}` : e.label}</span>
        </button>
      ))}
      <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>Transitions out</p>
      {outs.map((e) => (
        <div key={e.draft !== undefined ? `d${e.draft}` : `s${e.shipped}`} className="rounded-lg px-1 py-0.5 hover:bg-white/5">
          <div className="flex items-center gap-2 px-1 py-1 text-[12.5px]">
            <MIcon name="logout" size={16} />
            <button onClick={() => selectFlowScreen(e.to)} className="m3-focus rounded px-1 text-left">
              <span style={{ color: "var(--m3-on-surface-variant)" }}>{e.draft !== undefined ? `◈ ${e.label}` : e.label} →</span>
              <span className="font-mono text-xs"> {FLOW_SCREENS[e.to].title}</span>
            </button>
            {e.draft !== undefined ? (
              <button onClick={() => deleteFlowDraft(e.draft as number)} title="Delete draft transition" aria-label={`Delete draft transition ${e.label}`} className="m3-focus ml-auto grid h-8 w-8 place-items-center rounded-full">
                <MIcon name="delete" size={17} />
              </button>
            ) : (
              <button onClick={() => removeFlowEdge(e.shipped as number)} title="Remove transition (local draft)" aria-label={`Remove transition ${e.label}`} className="m3-focus ml-auto grid h-8 w-8 place-items-center rounded-full">
                <MIcon name="link_off" size={17} />
              </button>
            )}
          </div>
          {e.draft !== undefined && (
            <div className="px-1 pb-1">
              <DraftField label="transition label" value={e.label} mono onCommit={(next) => renameFlowDraft(e.draft as number, next)} />
            </div>
          )}
        </div>
      ))}
      <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
        Routes, guards and transitions edit as local drafts — Reset document restores the shipped graph; the scenes slice persists them.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- flow HUD (ux-16)

const WIDGET_DATA: Record<string, { x: string; y: string; w: string; h: string; on: boolean[] }> = {
  "Player frame": { x: "-16", y: "16", w: "320", h: "120", on: [true, true, true, false] },
  "Target frame": { x: "-340", y: "16", w: "300", h: "120", on: [true, true, true, false] },
  "Party frame": { x: "-16", y: "150", w: "220", h: "200", on: [true, true, false, false] },
  "Chat": { x: "-16", y: "-320", w: "480", h: "280", on: [true, true, true, false] },
  "Bag": { x: "-360", y: "-300", w: "340", h: "220", on: [true, true, true, false] },
  "Character sheet": { x: "-16", y: "16", w: "360", h: "480", on: [true, false, false, false] },
  "Action bar": { x: "0", y: "-80", w: "640", h: "64", on: [true, true, true, false] },
  "Minimap": { x: "-16", y: "16", w: "220", h: "220", on: [true, false, false, false] },
  "Quest tracker": { x: "-16", y: "212", w: "220", h: "auto ≤ 260", on: [true, true, false, false] },
  "Needs meters": { x: "-16", y: "150", w: "220", h: "90", on: [true, false, false, false] },
};

const hudStore = createStore<{ widget: string; geom: Record<string, Partial<{ x: string; y: string; w: string; h: string }>> }>({
  widget: "Quest tracker",
  geom: {},
});

export function useHudWidget(): string {
  return hudStore.use().widget;
}

export function useHudGeom(widget: string): { x: string; y: string; w: string; h: string } {
  const { geom } = hudStore.use();
  return { ...WIDGET_DATA[widget], ...geom[widget] } as { x: string; y: string; w: string; h: string };
}

function commitHudGeom(widget: string, field: "x" | "y" | "w" | "h", next: string): void {
  hudStore.set((p) => ({ ...p, geom: { ...p.geom, [widget]: { ...p.geom[widget], [field]: next } } }));
}

export function selectHudWidget(widget: string): void {
  hudStore.set((p) => ({ ...p, widget }));
}

export { hudStore };

const WIDGETS: Array<[string, string]> = [
  ["Player frame", "core"], ["Target frame", "core"], ["Party frame", "core"], ["Chat", "core"],
  ["Bag", "core"], ["Character sheet", "core"], ["Action bar", "core"], ["Minimap", "core"],
  ["Quest tracker", "story"], ["Needs meters", "survival"],
];

export function WidgetList(): React.JSX.Element {
  const widget = useHudWidget();
  return (
    <div>
      <ul className="flex flex-col gap-0.5">
        {WIDGETS.map(([w, tag]) => {
          const on = w === widget;
          return (
            <li key={w} className="group flex items-center gap-0.5 rounded-full" style={on ? { background: "var(--m3-secondary-container)" } : undefined}>
              <button
                onClick={() => selectHudWidget(w)}
                className="m3-focus flex h-10 min-w-0 flex-1 items-center gap-3 rounded-full px-3 text-sm"
                style={on ? { color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
              >
                <MIcon name="widgets" size={19} />{w}
                <span className="ml-auto text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{tag}</span>
              </button>
              <span className="flex-none opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <OverflowMenu
                  label={`${w} actions`}
                  items={[
                    { label: `Inspect ${w}`, icon: "search", run: () => selectHudWidget(w) },
                    "sep",
                    { label: "Rename…", icon: "edit", stagedFor: "EA · flow & UI" },
                    { label: "Duplicate", icon: "content_copy", stagedFor: "EA · flow & UI" },
                    { label: "Delete", icon: "delete", danger: true, stagedFor: "EA · flow & UI" },
                  ]}
                />
              </span>
            </li>
          );
        })}
      </ul>
      <SectionLabel>Player theme</SectionLabel>
      <div className="flex gap-1.5 px-1">
        {["#E8C33D", "#3a2c14", "#efe8d8", "#8a2f1a", "#4d7a45"].map((c) => (
          <span key={c} className="h-8 w-8 rounded-lg" style={{ background: c }} />
        ))}
      </div>
    </div>
  );
}

export function HudPreview(): React.JSX.Element {
  const widget = useHudWidget();
  const frame = (t: string, l: string, tp: string, w: string, h: string): React.JSX.Element => {
    const on = t === widget;
    return (
      <button
        key={t}
        onClick={() => selectHudWidget(t)}
        className="m3-focus absolute rounded-lg border-2 border-dashed p-2 text-left text-[13px]"
        style={{
          left: l, top: tp, width: w, height: h,
          borderColor: on ? "var(--m3-primary)" : "rgba(227,225,233,.55)",
          background: "rgba(13,14,19,.55)",
          boxShadow: on ? "0 0 0 2px var(--m3-primary)" : undefined,
        }}
      >
        {t}
      </button>
    );
  };
  return (
    <div className="flex flex-col gap-2">
      <PreviewBadge slice="EA · Flow & UI (§7c.6)">HUD layout at every UI scale and quality tier, saved to content/ui/hud.json.</PreviewBadge>
      <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
        {["1920 × 1080", "1280 × 720", "3440 × 1440"].map((r) => (
          <span key={r} className="rounded-full border px-3 py-1.5 font-mono text-xs" style={r === "1920 × 1080" ? { background: "var(--m3-secondary-container)", borderColor: "transparent" } : { borderColor: "var(--m3-outline-variant)", color: "var(--m3-on-surface-variant)" }}>{r}</span>
        ))}
        <span className="ml-2" style={{ color: "var(--m3-on-surface-variant)" }}>UI scale</span>
        <div className="flex h-9 items-center overflow-hidden rounded-full" style={{ border: "1px solid var(--m3-outline-variant)" }}>
          {["90 %", "100 %", "110 %", "125 %"].map((s) => (
            <span key={s} className="flex h-full items-center px-3 font-mono text-xs" style={s === "125 %" ? { background: "var(--m3-secondary-container)" } : undefined}>{s}</span>
          ))}
        </div>
        <span className="ml-auto rounded-full border px-3 py-1.5 font-mono text-xs" style={{ borderColor: "var(--m3-outline-variant)", color: "var(--m3-on-surface-variant)" }}>Scene: world</span>
      </div>
      <div className="relative overflow-hidden rounded-xl" style={{ height: 460, background: "linear-gradient(180deg,#2b3358 0%,#2b3358 42%,#2b5a8a 46%,#3f7a45 50%,#2f6136 100%)" }}>
        {frame("Player frame", "2%", "4%", "22%", "12%")}
        {frame("Target frame", "26%", "4%", "20%", "12%")}
        {frame("Party frame", "2%", "20%", "15%", "22%")}
        {frame("Chat", "2%", "66%", "32%", "30%")}
        {frame("Action bar", "26%", "88%", "44%", "9%")}
        <button
          onClick={() => selectHudWidget("Minimap")}
          className="m3-focus absolute rounded-full border-2 border-dashed p-2 text-center text-[13px]"
          style={{ right: "2%", top: "4%", width: "17%", aspectRatio: "1", borderColor: widget === "Minimap" ? "var(--m3-primary)" : "rgba(227,225,233,.55)", background: "rgba(13,14,19,.55)", boxShadow: widget === "Minimap" ? "0 0 0 2px var(--m3-primary)" : undefined }}
        >
          <span style={{ position: "relative", top: "38%" }}>Minimap</span>
        </button>
        <button
          onClick={() => selectHudWidget("Quest tracker")}
          className="m3-focus absolute rounded-lg border-2 p-2.5 text-left text-[12.5px]"
          style={{ right: "2%", top: "32%", width: "21%", borderColor: widget === "Quest tracker" ? "var(--m3-primary)" : "var(--m3-primary)", background: "rgba(13,14,19,.85)", boxShadow: widget === "Quest tracker" ? "0 0 0 2px var(--m3-primary)" : undefined }}
        >
          <p className="mb-1 flex">Quest tracker <span className="ml-auto"><Pill tone="ok">module</Pill></span></p>
          <p style={{ color: "#E8C33D" }}>The Old Watchtower</p>
          <p style={{ color: "var(--m3-on-surface-variant)" }}>☐ Clear a goblin camp 2/6<br />☐ Collect goblin ears 0/3</p>
          <p style={{ color: "#E8C33D" }}>Lost Pelts</p>
          <p style={{ color: "var(--m3-on-surface-variant)" }}>☑ Find the trapper</p>
        </button>
        <button
          onClick={() => selectHudWidget("Bag")}
          className="m3-focus absolute rounded-lg border-2 p-2 text-left text-[12.5px]"
          style={{ right: "2%", bottom: "3%", width: "28%", borderColor: "#FFB4AB", background: "rgba(122,46,18,.55)", boxShadow: widget === "Bag" ? "0 0 0 2px var(--m3-primary)" : undefined }}
        >
          Bag
        </button>
        <span className="absolute rounded-full px-2.5 py-1 font-mono text-[11px]" style={{ right: "31%", bottom: "26%", background: "#93000A", color: "#FFDAD6" }}>
          ⚠ Bag overlaps Action bar at 125 %
        </span>
        <span className="absolute rounded px-1.5 py-0.5 font-mono text-[11px]" style={{ right: "24%", top: "22%", background: "var(--m3-surface-0)" }}>anchor: top right</span>
      </div>
    </div>
  );
}

export function HudDetails(): React.JSX.Element {  const widget = useHudWidget();
  const d = useHudGeom(widget);
  const on = (WIDGET_DATA[widget] ?? WIDGET_DATA["Quest tracker"]).on;
  const scenes = ["World", "Dungeon", "Arena", "Cut scene"];
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
        {widget.toUpperCase()} · ANCHOR
      </p>
      <div className="grid grid-cols-4 gap-1">
        {Array.from({ length: 12 }, (_, i) => (
          <span key={i} className="rounded-md" style={{ height: 30, background: i === 5 ? "var(--m3-primary)" : "var(--m3-surface-3)" }} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(["x", "y", "w", "h"] as const).map((f) => (
          <DraftField
            key={`${widget}-${f}`}
            label={{ x: "Offset x", y: "Offset y", w: "Width", h: "Height" }[f]}
            value={d[f]}
            onCommit={(next) => commitHudGeom(widget, f, next)}
          />
        ))}
      </div>
      <SectionLabel>Visible on</SectionLabel>
      {scenes.map((l, i) => {
        const vis = on[i];
        return (
          <p key={l} className="flex items-center gap-2.5 text-sm">
            <span className="grid h-5 w-5 place-items-center rounded-[4px]" style={vis ? { background: "var(--m3-primary)", color: "var(--m3-on-primary)" } : { border: "2px solid var(--m3-outline)" }}>
              {vis ? <MIcon name="check" size={15} /> : null}
            </span>{l}
          </p>
        );
      })}
      <SectionLabel>Checks</SectionLabel>
      <p className="text-xs" style={{ color: "#9CD67D" }}>✓ No overlap at 90 to 110 %</p>
      <p className="text-xs" style={{ color: "#FFB4AB" }}>ⓘ Bag × Action bar at 125 %</p>
      <p className="text-xs" style={{ color: "#9CD67D" }}>✓ Fits 1280 × 720</p>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
        Saved to content/ui/hud.json. Players' own moves stay in their settings on top.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- deep links & ECS base
// Everything deep-links: the shell encodes workspace + view + selection in
// the URL hash, and every inspector drills to the ECS base — the engine's
// building blocks. Selection state stays in the shared stores above; this
// section only translates between stores and hash keys.

/** Read the current deep selection for a workspace view (null = none). */
export function readDeepSelection(workspace: string, view: string): string | null {
  switch (`${workspace}/${view}`) {
    case "database/grid": {
      const s = dbStore.get();
      return `row:${s.table}/${s.rowId}`;
    }
    case "story/quests":
      return `node:${storyStore.get().node}`;
    case "story/strings": {
      const r = stringsStore.get().row;
      return r ? `string:${r}` : null;
    }
    case "liveops/overview":
      return `player:${liveOpsStore.get().player}`;
    case "artaudio/animation":
      return `clip:${artStore.get().clip}`;
    case "artaudio/vfx":
      return `effect:${artStore.get().effect}`;
    case "artaudio/audio":
      return `event:${artStore.get().event}`;
    case "flow/hud":
      return `widget:${hudStore.get().widget}`;
    case "flow/flow":
      return `screen:${flowStore.get().screen}`;
    case "release/playtests":
      return `scenario:${releaseStore.get().scenario}`;
    default:
      return null;
  }
}

/** Apply a deep-selection key; returns the workspace/view it implies. */
export function applyDeepSelection(sel: string): { workspace: string; view: string } | null {
  const i = sel.indexOf(":");
  if (i < 0) return null;
  const kind = sel.slice(0, i);
  const rest = sel.slice(i + 1);
  switch (kind) {
    case "row": {
      const slash = rest.lastIndexOf("/");
      if (slash < 0) return null;
      const table = rest.slice(0, slash);
      const rowId = Number(rest.slice(slash + 1));
      if (!TABLE_INFO[table] || !Number.isInteger(rowId)) return null;
      dbStore.set((p) => ({ ...p, table, rowId }));
      return { workspace: "database", view: "grid" };
    }
    case "node":
      if (!QUEST_NODES[rest]) return null;
      storyStore.set((p) => ({ ...p, node: rest }));
      return { workspace: "story", view: "quests" };
    case "string":
      stringsStore.set((p) => ({ ...p, row: rest }));
      return { workspace: "story", view: "strings" };
    case "player":
      liveOpsStore.set({ player: rest });
      return { workspace: "liveops", view: "overview" };
    case "clip":
      if (!CLIPS.some(([c]) => c === rest)) return null;
      artStore.set((p) => ({ ...p, clip: rest }));
      return { workspace: "artaudio", view: "animation" };
    case "effect":
      if (!EFFECTS.some(([e]) => e === rest)) return null;
      artStore.set((p) => ({ ...p, effect: rest }));
      return { workspace: "artaudio", view: "vfx" };
    case "event":
      artStore.set((p) => ({ ...p, event: rest }));
      return { workspace: "artaudio", view: "audio" };
    case "widget":
      if (!WIDGET_DATA[rest]) return null;
      selectHudWidget(rest);
      return { workspace: "flow", view: "hud" };
    case "screen":
      if (!FLOW_SCREENS[rest]) return null;
      selectFlowScreen(rest);
      return { workspace: "flow", view: "flow" };
    case "scenario":
      releaseStore.set({ scenario: rest });
      return { workspace: "release", view: "playtests" };
    default:
      return null;
  }
}

/** ECS base layer: the authoritative components a document decomposes to. */
export function EcsChips({ components, caption }: { components: string[]; caption?: string }): React.JSX.Element {
  return (
    <div>
      <SectionLabel>Decomposes to · ECS base</SectionLabel>
      <div className="flex flex-wrap gap-1.5">
        {components.map((c) => (
          <span
            key={c}
            className="rounded-md px-2 py-1 font-mono text-[11px]"
            style={{ background: "var(--m3-surface-4)", color: "var(--m3-on-surface)" }}
          >
            {c}
          </span>
        ))}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
        {caption ?? "Authoritative components — the Scene workspace ECS inspector reads them live; the editor never writes a running simulation."}
      </p>
    </div>
  );
}
