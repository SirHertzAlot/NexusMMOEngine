/**
 * The Play menu (EA14, §3.5): every way to run the game. The setup is owned
 * by the shell and persisted on every change; Play hands off to the Play
 * mode panel, which owns start/stop. Saved setups live in
 * play-setups-store (the repo document content/play/setups.json) and can
 * carry a key that starts them. Every choice here reaches the start path.
 */

import * as React from "react";
import { CheckField, Field, Input, MIcon, Select, notify } from "./components.js";
import {
  MAX_PLAY_BOTS,
  MAX_PLAY_CLIENTS,
  PLAY_FROM,
  PLAY_LATENCY,
  PLAY_NET,
  loadLastSetup,
  playSetupSchema,
  setupDetail,
  setupSummary,
  type PlaySetup,
  type SavedPlaySetup,
} from "./play-setup.js";
import { bindSetupKey, deleteSetup, saveSetupAs, savedSetupsStore, setupsSaveError } from "./play-setups-store.js";
import { startChoices } from "./play-launch.js";
import { getFlow } from "../flow-client.js";
import { shortcutFromEvent } from "./play-shortcuts.js";

const WHERE_CARDS: Array<[PlaySetup["where"], string, string, string]> = [
  ["viewport", "fullscreen", "In viewport", "Panels stay around it"],
  ["window", "open_in_new", "New window", "The player's client"],
  ["simulate", "visibility", "Simulate", "World only, no player"],
];

const CLIENT_COUNTS = Array.from({ length: MAX_PLAY_CLIENTS }, (_, i) => String(i + 1));

export function PlayMenu({ setup, onChange, onPlay, onClose }: {
  setup: PlaySetup;
  onChange: (s: PlaySetup) => void;
  onPlay: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const saved = savedSetupsStore.useValue();
  const saveError = setupsSaveError.useValue();
  const [flow, setFlow] = React.useState<Awaited<ReturnType<typeof getFlow>>["content"] | null>(null);
  React.useEffect(() => {
    void getFlow().then((b) => setFlow(b.content), () => setFlow(null));
  }, []);
  const [name, setName] = React.useState("");
  const set = (patch: Partial<PlaySetup>): void => onChange({ ...setup, ...patch });
  const whereLabel = setup.where === "viewport" ? "in viewport" : setup.where === "window" ? "in a new window" : "simulate";
  const botsOk = playSetupSchema.shape.bots.safeParse(setup.bots).success;
  const playNow = (): void => {
    onClose();
    onPlay();
  };
  const saveCurrent = (): void => {
    if (name.trim() === "") return;
    saveSetupAs(name, setup);
    notify(`Setup “${name.trim()}” saved to content/play/setups.json`);
    setName("");
  };

  return (
    <menu
      className="m3-scroll max-h-[80vh] w-[32rem] overflow-y-auto rounded-2xl p-4"
      style={{ background: "var(--m3-surface-3)", boxShadow: "0 6px 16px rgba(0,0,0,.5)" }}
      aria-label="Play menu"
    >
      <MenuLabel>Where to play</MenuLabel>
      <div className="mb-3 grid grid-cols-3 gap-2">
        {WHERE_CARDS.map(([id, icon, title, body]) => {
          const on = setup.where === id;
          return (
            <button
              key={id}
              onClick={() => set({ where: id })}
              aria-pressed={on}
              className="m3-focus flex flex-col gap-1 rounded-xl p-3 text-left"
              style={on ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { background: "var(--m3-surface-2)", color: "var(--m3-on-surface)" }}
            >
              <MIcon name={icon} size={22} />
              <span className="text-sm font-medium">{title}</span>
              <span className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{body}</span>
            </button>
          );
        })}
      </div>

      <MenuLabel>Test setup</MenuLabel>
      <div className="mb-3 grid grid-cols-2 gap-x-3 gap-y-2">
        <Field label="Start node">
          <Select aria-label="Start node" value={setup.from} onChange={(e) => set({ from: e.target.value })}>
            {[...startChoices(flow, PLAY_FROM), ...(startChoices(flow, PLAY_FROM).some((c) => c.value === setup.from) ? [] : [{ value: setup.from, label: setup.from }])].map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Clients (each with its own seeded account)">
          <Select aria-label="Clients" value={setup.clients} onChange={(e) => set({ clients: e.target.value })}>
            {CLIENT_COUNTS.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </Select>
        </Field>
        <Field label={`Bots near spawn (0 to ${MAX_PLAY_BOTS})`} error={botsOk ? null : `Use a whole number from 0 to ${MAX_PLAY_BOTS}`}>
          <Input aria-label="Bots" inputMode="numeric" value={setup.bots} className={botsOk ? undefined : "border-red-500"} onChange={(e) => set({ bots: e.target.value.trim() })} />
        </Field>
        <Field label="Simulated latency">
          <Select aria-label="Simulated latency" value={setup.latency} onChange={(e) => set({ latency: e.target.value })}>
            {[...new Set<string>([...PLAY_LATENCY, setup.latency])].map((o) => (
              <option key={o} value={o}>{o === "0" ? "None" : o}</option>
            ))}
          </Select>
        </Field>
        <Field label="Network">
          <Select aria-label="Network" value={setup.net} onChange={(e) => set({ net: e.target.value as PlaySetup["net"] })}>
            {PLAY_NET.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex flex-col gap-2 text-sm">
        <CheckField checked={setup.fresh} onChange={(fresh) => set({ fresh })} label="Fresh world from the scene (discard saved state)" />
        <CheckField checked={setup.keep} onChange={(keep) => set({ keep })} label="Keep play changes on stop" />
        <CheckField checked={setup.tint} onChange={(tint) => set({ tint })} label="Tint the editor while playing" />
      </div>

      <div className="mt-3 flex flex-col gap-1.5 text-sm" style={{ borderTop: "1px solid var(--m3-outline-variant)", paddingTop: 10 }}>
        <button
          onClick={playNow}
          className="m3-focus flex items-center gap-2 rounded-lg px-2 py-1.5 text-left"
          style={{ color: "var(--m3-on-surface-variant)" }}
          title="Play with the last settings (F5)"
        >
          <MIcon name="history" size={16} /> Last: {setupSummary(loadLastSetup())}
          <kbd className="ml-auto rounded border px-1 font-mono text-[11px]" style={{ borderColor: "var(--m3-outline-variant)" }}>F5</kbd>
        </button>
        {saved.map((s) => (
          <SavedRow key={s.name} item={s} onApply={() => {
            onChange({ ...s.setup });
            notify(`Setup “${s.name}” applied — Play runs it`);
          }} />
        ))}
        {saveError && <p className="px-2 text-[11px]" style={{ color: "var(--m3-error)" }} role="alert">Saved setups not written to the repo: {saveError}</p>}
        <div className="flex items-center gap-1.5 px-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveCurrent();
            }}
            placeholder="Name this setup…"
            aria-label="Setup name"
            className="min-w-0 flex-1"
          />
          <button
            onClick={saveCurrent}
            className="m3-focus h-9 rounded-full px-3 text-sm font-medium"
            style={{ background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }}
          >
            Save
          </button>
        </div>
      </div>

      <button
        onClick={playNow}
        className="m3-focus mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-full text-sm font-semibold"
        style={{ background: "var(--m3-tertiary-container)", color: "var(--m3-on-tertiary-container)" }}
      >
        <MIcon name="play_arrow" size={20} />
        Play — {whereLabel} · {setup.from} · {setup.clients} client{setup.clients === "1" ? "" : "s"}
      </button>
    </menu>
  );
}

function MenuLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>
      {children}
    </p>
  );
}

/** One saved setup: apply it, give it a key, delete it. */
function SavedRow({ item, onApply }: { item: SavedPlaySetup; onApply: () => void }): React.JSX.Element {
  return (
    <div className="group flex flex-wrap items-center gap-1" data-testid={`saved-setup-${item.name}`}>
      <button
        onClick={onApply}
        className="m3-focus flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left"
        style={{ color: "var(--m3-on-surface-variant)" }}
        title={`Apply “${item.name}”: ${setupSummary(item.setup)}`}
      >
        <MIcon name="bookmark" size={16} />
        <span className="truncate">{item.name} · {setupDetail(item.setup)}</span>
      </button>
      <KeyCapture item={item} />
      <button
        onClick={() => deleteSetup(item.name)}
        aria-label={`Delete setup ${item.name}`}
        title={`Delete setup ${item.name}`}
        className="m3-focus rounded-full p-1 opacity-60 group-hover:opacity-100"
      >
        <MIcon name="delete" size={16} />
      </button>
    </div>
  );
}

/** The key chip: click, press the chord (Backspace clears, Esc cancels). */
function KeyCapture({ item }: { item: SavedPlaySetup }): React.JSX.Element {
  const [listening, setListening] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!listening) return;
    function onKey(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setListening(false);
        return;
      }
      const clear = e.key === "Backspace" || e.key === "Delete";
      const chord = clear ? null : shortcutFromEvent(e);
      if (!clear && chord === null) return;
      setError(bindSetupKey(item.name, chord));
      setListening(false);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, item.name]);
  return (
    <>
      <button
        onClick={() => {
          setError(null);
          setListening((v) => !v);
        }}
        aria-label={`Key for ${item.name}`}
        title={listening ? "Press the keys (Backspace clears, Esc cancels)" : "Set the key that starts this setup"}
        className="m3-focus h-7 flex-none rounded-md border px-2 font-mono text-[11px]"
        style={{ borderColor: error ? "var(--m3-error)" : "var(--m3-outline-variant)", color: "var(--m3-on-surface-variant)" }}
      >
        {listening ? "Press keys…" : (item.shortcut ?? "Set key")}
      </button>
      {error && <p className="basis-full px-2 text-[11px]" style={{ color: "var(--m3-error)" }} role="alert">{error}</p>}
    </>
  );
}
