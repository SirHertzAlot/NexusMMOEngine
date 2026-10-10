/**
 * Preview panes for the workspaces whose real panels have not landed yet
 * (UI-ONLY): Live ops, the Quest graph, Playtests. Each is badged as a
 * preview over sample data and reads or writes nothing in the engine; when
 * its real panel lands it replaces the preview one-for-one. Every other
 * workspace (database, flow, HUD, animation, VFX, audio, pipeline) already
 * has its real panel, and its sample-data preview was removed.
 *
 * Also home to the small shared widgets those panels use (Pill, BarRow,
 * SectionLabel, DraftField...) and the deep-link translation between the
 * URL hash and the selection stores.
 */

import * as React from "react";
import { createStore } from "../store.js";
import { useDrag } from "./use-drag.js";
import { SelectableList } from "./selectable-list.js";
import { DataTable } from "./data-table.js";
import { MIcon, TreeItem, notify } from "./components.js";
import { assetUiStore, setAssetFilter, setAssetPreview, useAssetManifest } from "./asset-inspector.js";
import { Chart } from "./charts.js";
import { LiveOpsTelemetry } from "./liveops-telemetry.js";
import { editorSelection } from "./editor-selection.js";
import { stringsStore } from "./strings-selection.js";

// ---------------------------------------------------------------- shared UI state
// Doc §3.1: selection is a shared model, not panel state — picking in any
// view feeds every inspector. These tiny external stores are the shell's
// UI-only version of that: selection + local drafts. Nothing here touches
// the simulation; backend slices replace the sample data one-for-one.

/** Subscribe to every selection store (drives hash sync; one call). */
export function subscribeDeepSelection(fn: () => void): () => void {
  const unsubs = [storyStore, stringsStore, liveOpsStore, releaseStore].map((s) => s.subscribe(fn));
  const unsubSel = editorSelection.subscribe(fn);
  return () => {
    unsubs.forEach((u) => u());
    unsubSel();
  };
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

const CRUD_ACTIONS: Array<[string, string]> = [
  ["visibility", "Inspect"],
  ["edit", "Edit"],
  ["content_copy", "Duplicate"],
  ["delete", "Delete"],
];

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
      <DataTable
        mono={mono}
        rows={rows}
        rowKey={(_, i) => String(i)}
        rowActions={crud ? (_, i) => CRUD_ACTIONS.map(([icon, label]) => (
          <button
            key={icon}
            title={`${label} row ${i + 1} — staged`}
            aria-label={`${label} row ${i + 1} (staged)`}
            onClick={() => notify(`${label} row ${i + 1} — staged for ${crud}`)}
            className="m3-focus rounded-full p-1"
            style={{ color: "var(--m3-on-surface-variant)" }}
          >
            <MIcon name={icon} size={15} />
          </button>
        )) : undefined}
        columns={head.map((h, j) => ({ id: `${j}:${h}`, header: h, nowrap: true, cell: (r: React.ReactNode[]) => r[j] }))}
      />
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

const liveOpsStore = createStore<{ player: string; scope: LiveOpsScope }>({
  player: "Aria",
  scope: { kind: "all" },
});

export { liveOpsStore };

/** Drill-down scope for the Live ops workspace. Account/guild/party
 *  scopes filter the players table; telemetry/chat/ledger swap in their
 *  dedicated section. Sample org data until the sessions endpoint lands. */
export type LiveOpsScope =
  | { kind: "all" }
  | { kind: "account"; name: string }
  | { kind: "guild"; name: string }
  | { kind: "party"; name: string }
  | { kind: "telemetry" }
  | { kind: "chat" }
  | { kind: "ledger" };

export const LIVEOPS_ACCOUNTS: Record<string, string[]> = {
  aria: ["Aria"],
  bram: ["Bram"],
  shell: ["Cass", "Fenn"],
  dov: ["Dov"],
  elin: ["Elin"],
  gale: ["Gale"],
  hale: ["Hale"],
};

export const LIVEOPS_GUILDS: Record<string, string[]> = {
  "Coast Wardens": ["Aria", "Bram", "Dov", "Hale"],
  "Ember Company": ["Cass", "Fenn"],
};

export const LIVEOPS_PARTIES: Record<string, string[]> = {
  "party-1": ["Aria", "Hale"],
  "party-2": ["Cass"],
};

export function selectLiveOpsPlayer(player: string): void {
  liveOpsStore.set((p) => ({ ...p, player }));
}

export function selectLiveOpsScope(scope: LiveOpsScope): void {
  liveOpsStore.set((p) => ({ ...p, scope }));
}

export function clearLiveOpsScope(): void {
  liveOpsStore.set((p) => ({ ...p, scope: { kind: "all" } }));
}

/** Whether a character row belongs in a scope (pure, tested). */
export function playerVisibleInScope(name: string, scope: LiveOpsScope): boolean {
  switch (scope.kind) {
    case "all":
    case "telemetry":
    case "chat":
    case "ledger":
      return true;
    case "account":
      return (LIVEOPS_ACCOUNTS[scope.name] ?? []).includes(name);
    case "guild":
      return (LIVEOPS_GUILDS[scope.name] ?? []).includes(name);
    case "party":
      return (LIVEOPS_PARTIES[scope.name] ?? []).includes(name);
  }
}

export function liveOpsScopeLabel(scope: LiveOpsScope): string {
  switch (scope.kind) {
    case "all":
      return "All players";
    case "account":
      return `Account ${scope.name}`;
    case "guild":
      return `Guild ${scope.name}`;
    case "party":
      return `Party ${scope.name}`;
    case "telemetry":
      return "Telemetry";
    case "chat":
      return "Chat & events";
    case "ledger":
      return "Item ledger";
  }
}

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
  const { player, scope } = liveOpsStore.use();
  const scoped = scope.kind !== "all";
  const section = scope.kind === "telemetry" || scope.kind === "chat" || scope.kind === "ledger" ? scope.kind : null;
  const visible = PLAYERS.filter(([c]) => playerVisibleInScope(c, scope));
  return (
    <div className="flex flex-col gap-3">
      <PreviewBadge slice="EA · Live ops (A1–A5)">Players, regions and audit data remain staged. Server telemetry below is live and read-only.</PreviewBadge>
      <LiveOpsTelemetry />
      <div className="overflow-x-auto rounded-xl" style={{ background: "var(--m3-surface-2)" }}>
        <div className="flex items-center gap-2 p-3 pb-0 text-sm font-medium">
          {section === null ? "Players" : liveOpsScopeLabel(scope)}
          {scoped && (
            <button
              onClick={clearLiveOpsScope}
              title="Clear scope — back to all players"
              className="m3-focus rounded-full px-2.5 py-1 font-mono text-[11px]"
              style={{ background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }}
            >
              {liveOpsScopeLabel(scope)} ✕
            </button>
          )}
          <button
            onClick={() => notify("Add player — staged for EA · live ops (seeded editor accounts in play setups)")}
            title="Add player (staged)"
            className="m3-focus ml-auto flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
            style={{ background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }}
          >
            <MIcon name="add" size={15} />Add
          </button>
        </div>
        <DataTable
          rows={visible}
          rowKey={([c]) => c}
          selected={([c]) => c === player}
          onPick={([c]) => selectLiveOpsPlayer(c)}
          rowTitle={([c]) => `Inspect ${c} in the admin console`}
          menu={([c]) => [
                          { label: `Inspect ${c}`, icon: "search", run: () => selectLiveOpsPlayer(c) },
                        ]}
          columns={[
            { id: "character", header: "Character", cell: ([c]) => c },
            { id: "scene", header: "Scene", cell: ([, s]) => s },
            { id: "region", header: "Region", mono: true, cell: ([, , r]) => r },
            { id: "rtt", header: "RTT", mono: true, cell: ([, , , rtt]) => rtt },
            { id: "state", header: "State", cell: ([, , , , st]) => <Pill tone={st === "dead" ? "err" : "info"}>{st}</Pill> },
            { id: "apm", header: "Actions/min", mono: true, cell: ([, , , , , a]) => a },
          ]}
        />
        {section !== null && <LiveOpsSection section={section} />}
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

/** Dedicated panel for telemetry/chat/ledger scopes (sample data until
 *  the sessions/telemetry endpoints land — same badge as the preview). */
export function LiveOpsSection({ section }: { section: "telemetry" | "chat" | "ledger" }): React.JSX.Element {
  if (section === "telemetry") {
    return (
      <div className="mt-3 rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
        <p className="mb-2 text-sm font-medium">Tick budget <span className="font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>· binds TelemetrySnapshot.tick when live</span></p>
        <MiniTable
          head={["Window", "p50", "p99", "Budget"]}
          rows={[
            ["10 s", "2.1 ms", "9.7 ms", "33 ms"],
            ["1 min", "2.4 ms", "11.2 ms", "33 ms"],
            ["1 h", "2.2 ms", "14.8 ms", "33 ms"],
          ]}
        />
        <p className="mt-2 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
          Series bind per-bucket kills/deaths/pickups/drops plus damage dealt/taken (60 × 10 s windows).
        </p>
      </div>
    );
  }
  if (section === "chat") {
    return (
      <div className="mt-3 rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
        <p className="mb-2 text-sm font-medium">Channels <span className="font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>· binds ChatBroadcast/FriendsState/PartyState/GuildState when live</span></p>
        <MiniTable
          head={["Channel", "Traffic/min", "Moderation"]}
          rows={[
            ["say · Starter Coast", "812", "—"],
            ["yell · Ember Peaks", "96", "1 muted"],
            ["party · party-1", "143", "—"],
            ["guild · Coast Wardens", "88", "—"],
            ["whisper", "211", "2 blocked"],
          ]}
        />
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
      <p className="mb-2 text-sm font-medium">Item ledger <span className="font-mono text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>· binds item_events rows when live</span></p>
      <MiniTable
        mono
        head={["seq", "item", "tick", "kind", "def", "owner"]}
        rows={[
          ["991204", "40112", "881203", "drop", "goblin_ear", "—"],
          ["991205", "40113", "881204", "pickup", "goblin_ear", "Aria"],
          ["991206", "88210", "881207", "give", "health_potion", "Bram"],
          ["991207", "40113", "881209", "trade", "goblin_ear", "Hale"],
        ]}
      />
    </div>
  );
}

export function LiveOpsDetails(): React.JSX.Element {
  const { player, scope } = liveOpsStore.use();
  const st = playerStats(player);
  return (
    <div className="flex flex-col gap-2 font-mono text-xs leading-relaxed">
      <p className="font-sans text-sm font-medium" style={{ color: "var(--m3-on-surface)" }}>Admin console</p>
      {scope.kind !== "all" && (
        <button
          onClick={clearLiveOpsScope}
          title="Clear scope — back to all players"
          className="m3-focus rounded-lg px-2 py-1.5 text-left text-[12px]"
          style={{ background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }}
        >
          Scope: {liveOpsScopeLabel(scope)} ✕
        </button>
      )}
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

// ---------------------------------------------------------------- story (ux-13, ux-18)

/** Set while a node drag (not a click) is in flight — clicks check and clear it. */
const graphDragMoved = { moved: false };

/** Midpoint handle that bends an edge's line. Drag to shape, double-click
 *  to straighten. Hidden until hover (draft edges always show it). */
function BendHandle({ x, y, accent, toUnits, onMove, onReset }: {
  x: number;
  y: number;
  accent: boolean;
  toUnits: (clientX: number, clientY: number) => { x: number; y: number };
  onMove: (x: number, y: number) => void;
  onReset: () => void;
}): React.JSX.Element {
  const drag = useDrag<true>({
    threshold: 5,
    stopPropagation: true,
    start: () => {
      graphDragMoved.moved = false;
      return true;
    },
    move: (ev) => {
      graphDragMoved.moved = true;
      const p = toUnits(ev.clientX, ev.clientY);
      onMove(p.x, p.y);
    },
  });
  return (
    <g opacity={accent ? 1 : 0} className="group-hover:opacity-100">
      <circle
        cx={x}
        cy={y}
        r={13}
        fill="rgba(0,0,0,0)"
        style={{ cursor: "move" }}
        {...drag.handlers}
        onDoubleClick={(ev) => {
          ev.stopPropagation();
          onReset();
        }}
      >
        <title>Drag to shape the line · double-click to straighten</title>
      </circle>
      <circle cx={x} cy={y} r={4.5} fill="#1E1F25" stroke={accent ? "#B9C3FF" : "#90909A"} strokeWidth={1.5} pointerEvents="none" />
      <circle cx={x} cy={y} r={1.5} fill={accent ? "#B9C3FF" : "#90909A"} pointerEvents="none" />
    </g>
  );
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}


const QUEST_NODES: Record<string, { title: string; header: string; lines: string[]; w: number; home: { x: number; y: number } }> = {
  talk: { title: "Talk to Warden Hale", header: "#36449A", lines: ["Hale · Starter Coast", "dialog: hale.intro"], w: 150, home: { x: 20, y: 40 } },
  clear: { title: "Clear a goblin camp", header: "#7A2E12", lines: ["slot: goblin camp ≤ 2 chunks", "seed 1337 · camp at 3,1", "kill 6 · goblin"], w: 190, home: { x: 250, y: 30 } },
  return: { title: "Return to Hale", header: "#36449A", lines: ["dialog: hale.return"], w: 150, home: { x: 520, y: 40 } },
  reward: { title: "Reward", header: "#1F5110", lines: ["40 silver", "loot: hale_reward", "standing +10"], w: 150, home: { x: 730, y: 40 } },
  refused: { title: "Refused", header: "#5a3a1a", lines: ['"I\'ll think about it"', "leads nowhere"], w: 150, home: { x: 20, y: 220 } },
  collect: { title: "Collect goblin ears", header: "#7A2E12", lines: ["3 × goblin_ear", "drop 60 % (goblin_quest)"], w: 190, home: { x: 250, y: 220 } },
  optional: { title: "Optional: the tower", header: "#3a3355", lines: ["instance: watchtower", "slot: dungeon pool · d1"], w: 170, home: { x: 520, y: 220 } },
  bonus: { title: "Bonus reward", header: "#1F5110", lines: ["loot: tower_cache", "unlocks: tower-key"], w: 150, home: { x: 730, y: 220 } },
};

const QUEST_EDGES: Array<{ from: string; to: string; label?: string; dashed?: boolean }> = [
  { from: "talk", to: "clear" },
  { from: "clear", to: "return" },
  { from: "return", to: "reward" },
  { from: "talk", to: "refused", label: "refuse", dashed: true },
  { from: "clear", to: "collect", label: "camp cleared" },
  { from: "collect", to: "optional", dashed: true },
  { from: "optional", to: "bonus" },
  { from: "collect", to: "return", label: "3 ears" },
];

export interface QuestEdgeDraft {
  id: number;
  from: string;
  to: string;
  label: string;
}

export interface QuestEdgeView {
  from: string;
  to: string;
  label: string;
  dashed?: boolean;
  shipped?: number;
  draft?: number;
}

const storyStore = createStore<{
  node: string;
  lines: Record<string, string[]>;
  pos: Record<string, { x: number; y: number }>;
  edgeDrafts: QuestEdgeDraft[];
  edgeRemoved: number[];
  seq: number;
  bend: Record<string, { x: number; y: number }>;
}>({
  node: "clear",
  lines: {},
  pos: {},
  edgeDrafts: [],
  edgeRemoved: [],
  seq: 1,
  bend: {},
});

export { storyStore };

function questBox(id: string): { x: number; y: number; w: number; h: number } {
  const n = QUEST_NODES[id];
  const o = storyStore.get().pos[id];
  const rendered = storyStore.get().lines[id] ?? n.lines;
  return { x: o?.x ?? n.home.x, y: o?.y ?? n.home.y, w: n.w, h: 34 + rendered.length * 20 };
}

export function moveQuestNode(id: string, x: number, y: number): void {
  const n = QUEST_NODES[id];
  if (!n) return;
  const cx = Math.min(900 - n.w, Math.max(0, Math.round(x)));
  const cy = Math.min(300, Math.max(0, Math.round(y)));
  storyStore.set((p) => ({ ...p, pos: { ...p.pos, [id]: { x: cx, y: cy } } }));
}

/** Shipped quest edges minus locally-removed, plus local drafts. */
export function getQuestEdges(): QuestEdgeView[] {
  const { edgeDrafts, edgeRemoved } = storyStore.get();
  const kept = QUEST_EDGES.flatMap((e, i) =>
    edgeRemoved.includes(i) ? [] : [{ ...e, label: e.label ?? "", shipped: i }],
  );
  return [...kept, ...edgeDrafts.map((d) => ({ from: d.from, to: d.to, label: d.label, dashed: true, draft: d.id }))];
}

export function questDraftCount(): number {
  const { pos, edgeDrafts, edgeRemoved, bend } = storyStore.get();
  return Object.keys(pos).length + edgeDrafts.length + edgeRemoved.length + Object.keys(bend).length;
}

export function resetStoryLayout(): void {
  storyStore.set((p) => ({ ...p, pos: {}, edgeDrafts: [], edgeRemoved: [], bend: {} }));
  notify("Quest graph reset to the shipped version");
}

/** Identity key for a quest edge (shipped index or draft id). */
export function questEdgeKey(e: QuestEdgeView): string {
  return e.draft !== undefined ? `d${e.draft}` : `s${e.shipped}`;
}

export function setQuestBend(key: string, x: number, y: number): void {
  const cx = Math.min(900, Math.max(0, Math.round(x)));
  const cy = Math.min(340, Math.max(0, Math.round(y)));
  storyStore.set((p) => ({ ...p, bend: { ...p.bend, [key]: { x: cx, y: cy } } }));
}

export function clearQuestBend(key: string): void {
  storyStore.set((p) => {
    if (!p.bend[key]) return p;
    const bend = { ...p.bend };
    delete bend[key];
    return { ...p, bend };
  });
}

/** Rewire a quest edge's target by dragging it onto another step. Local only. */
export function rewireQuestEdge(edge: QuestEdgeView, to: string): void {
  if (!QUEST_NODES[to]) return;
  if (to === edge.from) {
    notify("A step cannot transition to itself");
    return;
  }
  if (to === edge.to) return;
  const dup = getQuestEdges().some(
    (e) => e.from === edge.from && e.to === to && e.draft !== edge.draft && e.shipped !== edge.shipped,
  );
  if (dup) {
    notify(`${QUEST_NODES[edge.from].title} → ${QUEST_NODES[to].title} already exists`);
    return;
  }
  if (edge.draft !== undefined) {
    const id = edge.draft;
    storyStore.set((p) => ({ ...p, node: to, edgeDrafts: p.edgeDrafts.map((d) => (d.id === id ? { ...d, to } : d)) }));
  } else {
    const shipped = edge.shipped as number;
    const label = QUEST_EDGES[shipped].label ?? `to ${QUEST_NODES[to].title.toLowerCase()}`;
    const oldKey = questEdgeKey(edge);
    storyStore.set((p) => {
      const bend = { ...p.bend };
      if (bend[oldKey]) {
        bend[`d${p.seq}`] = bend[oldKey];
        delete bend[oldKey];
      }
      return {
        ...p,
        node: to,
        seq: p.seq + 1,
        bend,
        edgeRemoved: p.edgeRemoved.includes(shipped) ? p.edgeRemoved : [...p.edgeRemoved, shipped],
        edgeDrafts: [...p.edgeDrafts, { id: p.seq, from: edge.from, to, label }],
      };
    });
  }
  notify(`Rewired ${QUEST_NODES[edge.from].title} → ${QUEST_NODES[to].title} locally — Reset restores the shipped graph`);
}

export function removeQuestEdge(shipped: number): void {
  const e = QUEST_EDGES[shipped];
  storyStore.set((p) => (p.edgeRemoved.includes(shipped) ? p : { ...p, edgeRemoved: [...p.edgeRemoved, shipped] }));
  if (e) notify(`Removed ${QUEST_NODES[e.from].title} → ${QUEST_NODES[e.to].title} locally — Reset restores it`);
}

export function deleteQuestDraft(id: number): void {
  storyStore.set((p) => ({ ...p, edgeDrafts: p.edgeDrafts.filter((d) => d.id !== id) }));
}

export interface QuestEdgeGeom {
  d: string;
  lx: number;
  ly: number;
  anchor?: "middle" | "end";
  cx: number;
  cy: number;
}

export function questEdgeGeom(e: QuestEdgeView): QuestEdgeGeom {
  const a = questBox(e.from);
  const b = questBox(e.to);
  let p0: [number, number];
  let p1: [number, number];
  let c: [number, number];
  let off: [number, number] = [0, 0];
  let anchor: "middle" | "end" | undefined;
  const bend = storyStore.get().bend[questEdgeKey(e)];
  if (Math.abs(a.y - b.y) < 40) {
    // Same row: right edge to left edge at mid heights.
    p0 = [a.x + a.w, a.y + Math.min(40, a.h / 2)];
    p1 = [b.x, b.y + Math.min(40, b.h / 2)];
    c = bend ? [bend.x, bend.y] : [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    off = [0, -10];
    anchor = "middle";
  } else if (Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) < 40) {
    // Same column: straight down through node centers, straight back up.
    const x = Math.round((a.x + a.w / 2 + (b.x + b.w / 2)) / 2);
    const down = a.y < b.y;
    p0 = down ? [x, a.y + a.h] : [a.x + 24, a.y];
    p1 = down ? [x, b.y] : [b.x + 24, b.y + b.h];
    c = bend ? [bend.x, bend.y] : [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    off = down ? [8, 4] : [-8, 4];
    anchor = down ? undefined : "end";
  } else {
    // Diagonal: right edge of source to top center of target, gently bowed.
    p0 = [a.x + a.w, a.y + 26];
    p1 = [b.x + b.w / 2, b.y];
    const mx = (p0[0] + p1[0]) / 2;
    const my = (p0[1] + p1[1]) / 2;
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const len = Math.hypot(dx, dy) || 1;
    c = bend ? [bend.x, bend.y] : [mx + (-dy / len) * 30, my + (dx / len) * 30];
    off = [-10, -8];
  }
  const qx = (p0[0] + 2 * c[0] + p1[0]) / 4;
  const qy = (p0[1] + 2 * c[1] + p1[1]) / 4;
  return {
    d: `M${r1(p0[0])},${r1(p0[1])} Q${r1(c[0])},${r1(c[1])} ${r1(p1[0])},${r1(p1[1])}`,
    lx: r1(qx + off[0]),
    ly: r1(qy + off[1]),
    anchor,
    cx: r1(c[0]),
    cy: r1(c[1]),
  };
}

function QuestNode({ id }: { id: string }): React.JSX.Element {
  const { node, lines } = storyStore.use();
  const n = QUEST_NODES[id];
  const box = questBox(id);
  const { x, y, w } = box;
  const rendered = lines[id] ?? n.lines;
  const selected = node === id;
  const h = 34 + rendered.length * 20;
  const drag = useDrag<{ ox: number; oy: number; k: number }>({
    threshold: 5,
    stopPropagation: true,
    start: (ev) => {
      graphDragMoved.moved = false;
      const k = 900 / ((ev.currentTarget as SVGGElement).ownerSVGElement?.getBoundingClientRect().width || 900);
      return { ox: x, oy: y, k };
    },
    move: (_ev, d0, d) => {
      graphDragMoved.moved = true;
      moveQuestNode(id, d0.ox + d.dx * d0.k, d0.oy + d.dy * d0.k);
    },
  });
  return (
    <g
      data-qnode={id}
      {...drag.handlers}
      onClick={() => {
        if (graphDragMoved.moved) { graphDragMoved.moved = false; return; }
        storyStore.set((p) => ({ ...p, node: id }));
      }}
      style={{ cursor: "pointer", touchAction: "none" }}
    >
      <title>{n.title} — click to inspect, drag to move</title>
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
  interface QuestWire { edge: QuestEdgeView; sx: number; sy: number; x: number; y: number }
  const wireRef = React.useRef<QuestWire | null>(null);
  const [wire, setWire] = React.useState<QuestWire | null>(null);
  const setWireBoth = (w: QuestWire | null): void => {
    wireRef.current = w;
    setWire(w);
  };
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const toUnits = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return { x: 0, y: 0 };
    const k = 900 / r.width;
    return { x: (clientX - r.left) * k, y: (clientY - r.top) * k };
  };
  const dropWire = (clientX: number, clientY: number): void => {
    const w = wireRef.current;
    setWireBoth(null);
    if (!w) return;
    const target = (document.elementFromPoint(clientX, clientY) as Element | null)?.closest?.("[data-qnode]");
    const to = target?.getAttribute("data-qnode") ?? null;
    if (to) {
      graphDragMoved.moved = true;
      rewireQuestEdge(w.edge, to);
    }
  };
  React.useEffect(() => {
    if (!wire) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") setWireBoth(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wire]);
  const edges = getQuestEdges();
  const dirty = questDraftCount();
  // Subscribe so node drags and edge rewires repaint paths, not just nodes.
  storyStore.use();
  return (
    <div className="flex flex-col gap-3">
      <PreviewBadge slice="EA · Story (§7c.3)">Quest and dialog graphs with the dialog tester and quest state.</PreviewBadge>
      <div className="flex items-center gap-2 text-[13px]">
        <span className="font-mono" style={{ color: "var(--m3-on-surface-variant)" }}>content/quests/warden-hale.quest.json</span>
        <Pill tone="info">1 slot · generated</Pill>
        {dirty > 0 && <Pill tone="warn">◈ {dirty} local draft{dirty === 1 ? "" : "s"}</Pill>}
        <span className="ml-auto flex gap-2">
          <Pill tone="plain">◈ Seed 1337</Pill>
          <Pill tone="plain">▷ Play from step</Pill>
        </span>
      </div>
      <svg ref={svgRef} viewBox="0 0 900 340" className="w-full rounded-xl" style={{ background: "var(--m3-surface-0)", backgroundImage: "radial-gradient(#2a2b31 1px, transparent 1px)", backgroundSize: "22px 22px", touchAction: "none" }} role="img" aria-label="Quest graph preview">
        <defs>
          <marker id="ah" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="#90909A" />
          </marker>
        </defs>
        {edges.map((e) => {
          const geom = questEdgeGeom(e);
          const custom = e.draft !== undefined;
          const key = questEdgeKey(e);
          return (
            <g key={key} className="group">
              <title>Drag to rewire onto another step</title>
              <path
                d={geom.d}
                stroke="rgba(0,0,0,0)"
                strokeWidth={14}
                pointerEvents="stroke"
                fill="none"
                style={{ cursor: "grab" }}
                onPointerDown={(ev) => {
                  if (ev.button !== 0 && ev.pointerType === "mouse") return;
                  ev.stopPropagation();
                  graphDragMoved.moved = false;
                  (ev.currentTarget as SVGPathElement).setPointerCapture?.(ev.pointerId);
                  const p = toUnits(ev.clientX, ev.clientY);
                  const sp = questBox(e.from);
                  setWireBoth({ edge: e, sx: sp.x + sp.w, sy: sp.y + 26, x: p.x, y: p.y });
                }}
                onPointerMove={(ev) => {
                  const w0 = wireRef.current;
                  if (!w0 || w0.edge.draft !== e.draft || w0.edge.shipped !== e.shipped) return;
                  const p = toUnits(ev.clientX, ev.clientY);
                  if (Math.abs(p.x - w0.sx) + Math.abs(p.y - w0.sy) > 6) graphDragMoved.moved = true;
                  setWireBoth({ ...w0, x: p.x, y: p.y });
                }}
                onPointerUp={(ev) => {
                  if (wireRef.current) dropWire(ev.clientX, ev.clientY);
                }}
              />
              <path
                d={geom.d}
                stroke={custom ? "#B9C3FF" : "#90909A"}
                strokeWidth={custom ? 2 : 1.5}
                strokeDasharray={e.dashed ? "5 4" : undefined}
                fill="none"
                pointerEvents="none"
                markerEnd="url(#ah)"
              />
              <BendHandle
                x={geom.cx}
                y={geom.cy}
                accent={custom || storyStore.get().bend[key] !== undefined}
                toUnits={toUnits}
                onMove={(x, y) => setQuestBend(key, x, y)}
                onReset={() => clearQuestBend(key)}
              />
            </g>
          );
        })}
        {wire && (
          <path
            d={`M${wire.sx},${wire.sy} C${wire.sx + 44},${wire.sy} ${wire.x},${wire.y - 44} ${wire.x},${wire.y}`}
            stroke="#B9C3FF"
            strokeWidth={2}
            strokeDasharray="5 4"
            fill="none"
            pointerEvents="none"
            markerEnd="url(#ah)"
          />
        )}
        {Object.keys(QUEST_NODES).map((id) => <QuestNode key={id} id={id} />)}
        {/* labels paint above nodes so tight gaps stay readable */}
        {edges.map((e) => {
          if (e.label === "") return null;
          const geom = questEdgeGeom(e);
          const custom = e.draft !== undefined;
          return (
            <text
              key={custom ? `dl${e.draft}` : `sl${e.shipped}`}
              x={geom.lx}
              y={geom.ly}
              textAnchor={geom.anchor}
              fill={custom ? "#B9C3FF" : "#C6C5D0"}
              fontSize="10"
              fontFamily="Roboto Mono, monospace"
              pointerEvents="none"
              stroke="var(--m3-surface-0)"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {custom ? `◈ ${e.label}` : e.label}
            </text>
          );
        })}
      </svg>
      <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
        <p className="mb-2 flex items-center text-sm font-medium">Validation
          {dirty > 0 && (
            <button onClick={resetStoryLayout} className="m3-focus ml-auto rounded-full px-3 py-1 text-xs font-medium" style={{ border: "1px solid var(--m3-outline-variant)", color: "var(--m3-on-surface-variant)" }}>
              Reset layout
            </button>
          )}
        </p>
        <MiniTable
          head={["", "Problem", "Where"]}
          rows={[
            ["ⓘ", "Reply leads nowhere", <span className="font-mono">hale.intro › reply 3</span>],
            ["⚠", "3 lines missing in fr", <span className="font-mono">hale.intro</span>],
            ["✓", "Reward items exist", <span className="font-mono">loot: hale_reward</span>],
            ...(dirty > 0 ? [[
              "◈",
              "Local layout drafts (reset restores shipped)",
              <span key="d" className="font-mono">{dirty} pending</span>,
            ]] : []),
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

// ---------------------------------------------------------------- art & audio

/** Library dock for the assets view: manifest groups with counts, a dock
 *  search that filters the panel's model table, and model picks that
 *  preview in the panel — same shared store, both directions. */
export function AssetLibraryTree(): React.JSX.Element {
  const { scan, loading, refresh } = useAssetManifest();
  const { filter, previewId } = assetUiStore.use();
  const [open, setOpen] = React.useState<string[]>(["models"]);
  const toggle = (id: string): void => setOpen((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const models = scan?.manifest?.models ?? [];
  const textures = scan?.manifest?.textures ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = models.filter((m) => needle === "" || m.id.toLowerCase().includes(needle)).slice(0, 12);
  const group = (id: string, label: string, trailing: string, kids: React.ReactNode): React.JSX.Element => (
    <div key={id} className="mb-1">
      <TreeItem
        icon="folder" label={label} trailing={trailing}
        hasKids expanded={open.includes(id)} onToggle={() => toggle(id)}
        selected={false} onPick={() => toggle(id)}
        menu={[
          { label: "Rescan pack", icon: "refresh", run: () => void refresh() },
        ]}
      />
      {open.includes(id) && kids}
    </div>
  );
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 px-1">
        <MIcon name="search" size={17} />
        <input
          value={filter}
          onChange={(e) => setAssetFilter(e.target.value)}
          placeholder="Filter models…"
          aria-label="Filter asset models"
          className="m3-focus h-8 min-w-0 flex-1 rounded-lg border bg-transparent px-2 font-mono text-xs"
          style={{ borderColor: "var(--m3-outline-variant)", color: "var(--m3-on-surface)" }}
        />
      </div>
      {group("pack", scan?.manifest?.name ?? "Art pack", scan?.manifest ? `v${scan.manifest.version}` : loading ? "…" : "missing", (
        <>
          <p className="px-3 py-1 pl-11 font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>
            {scan?.manifest ? `${models.length} models · ${textures.length} textures` : "drop art into assets/, then rescan"}
          </p>
          <button
            onClick={() => void refresh()}
            className="m3-focus ml-11 flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium"
            style={{ background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }}
          >
            <MIcon name="refresh" size={15} />{loading ? "Scanning…" : "Rescan"}
          </button>
        </>
      ))}
      {group("models", "Models", String(models.length), (
        <>
          {shown.map((m) => (
            <TreeItem
              key={m.id} icon="description" label={m.id} depth={1} mono
              selected={m.id === previewId}
              onPick={() => setAssetPreview(m.id)}
              menu={[
                { label: `Preview ${m.id}`, icon: "visibility", run: () => setAssetPreview(m.id) },
              ]}
            />
          ))}
          {models.length > shown.length && (
            <p className="px-3 py-1 pl-11 font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>
              +{models.length - shown.length} more — narrow the filter
            </p>
          )}
        </>
      ))}
      {group("textures", "Textures", String(textures.length), (
        <>
          {textures.slice(0, 12).map((t) => (
            <TreeItem
              key={t.id} icon="image" label={t.id} depth={1} mono
            />
          ))}
        </>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- release (ux-12, ux-19)

const releaseStore = createStore<{ scenario: string }>({ scenario: "camp-loop" });

export { releaseStore };

const SCENARIOS: Array<[string, string, "passed" | "failed" | "blocked"]> = [
  ["camp-loop", "12 bots · 200 s · arena-01", "failed"],
  ["coast-quest", "4 bots · warden-hale", "passed"],
  ["stress-200", "200 bots × 120 goblins", "passed"],
  ["ledger-soak", "loot and trade · 30 min", "passed"],
  ["login-flow", "8 clients · flow", "passed"],
  ["dungeon-run", "party of 5 · D4", "blocked"],
];

export function PlaytestPreview(): React.JSX.Element {
  const { scenario } = releaseStore.use();
  const scen = scenario;
  const trail = "M40,120 C90,60 120,140 170,90 S260,40 320,80 S420,150 480,110 S560,60 640,100";
  return (
    <div className="flex flex-col gap-3">
      <PreviewBadge slice="EA · Release (§7c.9)">Playtest scenarios, replays and results with assertions.</PreviewBadge>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[210px_1fr_250px]">
        <div className="rounded-xl p-2" style={{ background: "var(--m3-surface-2)" }}>
          <SelectableList
            items={SCENARIOS}
            itemKey={([s]) => s}
            label={([s]) => s}
            tag={([, , st]) => <Pill tone={st === "passed" ? "ok" : st === "failed" ? "err" : "warn"}>{st}</Pill>}
            detail={([, d]) => d}
            selected={scen}
            onPick={([s]) => releaseStore.set({ scenario: s })}
            menu={([s]) => [
              { label: `Inspect ${s}`, icon: "search", run: () => releaseStore.set({ scenario: s }) },
            ]}
          />
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

// ---------------------------------------------------------------- deep links & ECS base
// Everything deep-links: the shell encodes workspace + view + selection in
// the URL hash, and every inspector drills to the ECS base — the engine's
// building blocks. Selection state stays in the shared stores above; this
// section only translates between stores and hash keys.

/** Read the current deep selection for a workspace view (null = none). */
export function readDeepSelection(workspace: string, view: string): string | null {
  if (workspace === "scenes" && view === "scene") {
    const sel = editorSelection.get();
    if (!sel || !sel.id) return null;
    if (sel.kind === "scene" || sel.kind === "scene-node") return `scene:${sel.id}`;
    return null;
  }
  if (workspace === "dungeons" && view === "dungeons") {
    const sel = editorSelection.get();
    if (!sel || !sel.id) return null;
    if (sel.kind === "dungeon-room") return `dungeon-room:${sel.id}`;
    if (sel.kind === "dungeon-spawn") return `dungeon-spawn:${sel.id}`;
    if (sel.kind === "dungeon-prop") return `dungeon-prop:${sel.id}`;
    return null;
  }
  if (workspace === "scene" && view === "ecs") {
    const sel = editorSelection.get();
    if (sel && sel.kind === "entity" && sel.id) return `entity:${sel.id}`;
    return null;
  }
  switch (`${workspace}/${view}`) {
    case "story/quests":
      return `node:${storyStore.get().node}`;
    case "story/strings": {
      const r = stringsStore.get().row;
      return r ? `string:${r}` : null;
    }
    case "liveops/overview":
      return `player:${liveOpsStore.get().player}`;
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
    case "node":
      if (!QUEST_NODES[rest]) return null;
      storyStore.set((p) => ({ ...p, node: rest }));
      return { workspace: "story", view: "quests" };
    case "string":
      stringsStore.set((p) => ({ ...p, row: rest }));
      return { workspace: "story", view: "strings" };
    case "player":
      selectLiveOpsPlayer(rest);
      return { workspace: "liveops", view: "overview" };
    case "scenario":
      releaseStore.set({ scenario: rest });
      return { workspace: "release", view: "playtests" };
    case "scene": {
      if (!rest) return null;
      const slash = rest.indexOf("/");
      const kind = slash >= 0 ? "scene-node" : "scene";
      editorSelection.select({
        source: "outliner",
        kind,
        id: rest,
        label: rest,
        components: [{ name: "Scene", fields: [{ key: "name", value: rest }] }],
      });
      return { workspace: "scenes", view: "scene" };
    }
    case "dungeon-room":
    case "dungeon-spawn":
    case "dungeon-prop": {
      if (!rest) return null;
      const dungeonKind = kind as "dungeon-room" | "dungeon-spawn" | "dungeon-prop";
      editorSelection.select({
        source: "outliner",
        kind: dungeonKind,
        id: rest,
        label: rest,
        components: [{ name: "Dungeon", fields: [{ key: "id", value: rest }] }],
      });
      return { workspace: "dungeons", view: "dungeons" };
    }
    case "entity": {
      if (!rest) return null;
      editorSelection.select({
        source: "entity-list",
        kind: "entity",
        id: rest,
        label: rest,
        components: [],
      });
      return { workspace: "scene", view: "ecs" };
    }
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
