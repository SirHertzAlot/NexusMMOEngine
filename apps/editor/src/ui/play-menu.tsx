/**
 * The play menu (EA14, §3.5): every way to run the game. The setup is owned
 * by the shell and persisted on every change; Play starts the owned server
 * with it (play-mode.tsx). Saved setups live in content/play/setups.json
 * and may be bound to a key (F6 to F10, Alt+1 to Alt+9).
 */
import * as React from "react";
import { getFlow } from "../flow-client.js";
import { CAMERA, NETWORKS, LATENCIES, SETUP_SHORTCUTS, savePlaySetups, setupSummary, withSetup, withoutSetup, type PlaySetup, type PlaySetupsDoc } from "./play-setup.js";
import { Chip, MIcon, notify } from "./components.js";

const FALLBACK_NODES = ["login", "character-creation", "world"];

export function PlayMenu({ setup, onChange, onPlay, onClose, saved, onSaved }: {
  setup: PlaySetup;
  onChange: (s: PlaySetup) => void;
  onPlay: () => void;
  onClose: () => void;
  saved: PlaySetupsDoc;
  onSaved: (doc: PlaySetupsDoc) => void;
}): React.JSX.Element {
  const [name, setName] = React.useState("");
  const [key, setKey] = React.useState("");
  const [nodes, setNodes] = React.useState<string[]>(FALLBACK_NODES);
  React.useEffect(() => {
    let alive = true;
    getFlow().then(
      (b) => alive && setNodes(Object.keys(b.content.nodes)),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  const set = (patch: Partial<PlaySetup>): void => onChange({ ...setup, ...patch });
  const whereLabel = setup.where === "viewport" ? "in viewport" : setup.where === "window" ? "in a new window" : "simulate";

  async function persist(doc: PlaySetupsDoc, said: string): Promise<void> {
    try {
      await savePlaySetups(doc);
      onSaved(doc);
      notify(said);
    } catch (e) {
      notify(`Setup not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const saveCurrent = (): void => {
    const n = name.trim();
    if (n === "") return;
    void persist(withSetup(saved, n, setup, key === "" ? null : key), `Setup “${n}” saved${key ? ` on ${key}` : ""}`);
    setName("");
    setKey("");
  };

  return (
    <menu
      className="m3-scroll max-h-[80vh] w-[30rem] overflow-y-auto rounded-2xl p-4"
      style={{ background: "var(--m3-surface-3)", boxShadow: "0 6px 16px rgba(0,0,0,.5)" }}
      aria-label="Play menu"
    >
      <Label>Where to play</Label>
      <div className="mb-3 grid grid-cols-3 gap-2">
        {(
          [
            ["viewport", "fullscreen", "In viewport", "Panels stay around it"],
            ["window", "open_in_new", "New window", "The player's client"],
            ["simulate", "visibility", "Simulate", "World only, no player"],
          ] as Array<[string, string, string, string]>
        ).map(([id, icon, title, body]) => {
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

      <Label>Start from</Label>
      <div className="mb-2.5 flex flex-wrap gap-1.5" role="group" aria-label="Start from">
        {[...nodes.map((n) => [n, n] as const), [CAMERA, "camera position"] as const].map(([value, label]) => (
          <Chip key={value} selected={setup.from === value} onClick={() => set({ from: value })}>
            {setup.from === value && <MIcon name="check" size={15} />}
            {label}
          </Chip>
        ))}
      </div>

      <Label>Test setup</Label>
      <div className="mb-1 flex flex-col gap-2">
        <Split label="Clients" options={["1", "2", "4", "8"]} value={setup.clients} onPick={(v) => set({ clients: v })} />
        <Split label="Bots near spawn" options={["0", "10", "50", "200"]} value={setup.bots} onPick={(v) => set({ bots: v })} />
        <Split label="Network" options={[...NETWORKS]} value={setup.net} onPick={(v) => set({ net: v })} />
        <Split label="Simulated latency" options={[...LATENCIES]} value={setup.latency} onPick={(v) => set({ latency: v })} />
      </div>

      <div className="mt-2 flex flex-col gap-2.5 text-sm">
        <Check checked={setup.fresh} onFlip={() => set({ fresh: !setup.fresh })} label="Fresh world (terrain only; off continues the saved world)" />
        <Check checked={setup.keep} onFlip={() => set({ keep: !setup.keep })} label="Keep play changes on stop (writes the session's world back)" />
        <Check checked={setup.tint} onFlip={() => set({ tint: !setup.tint })} label="Tint the editor while playing" />
      </div>

      <div className="mt-3 flex flex-col gap-1.5 text-sm" style={{ borderTop: "1px solid var(--m3-outline-variant)", paddingTop: 10 }}>
        <button
          onClick={() => {
            onClose();
            onPlay();
          }}
          className="m3-focus flex items-center gap-2 rounded-lg px-2 py-1.5 text-left"
          style={{ color: "var(--m3-on-surface-variant)" }}
          title="Play with the last settings (F5)"
        >
          <MIcon name="history" size={16} /> Last: {setupSummary(setup)}
          <kbd className="ml-auto rounded border px-1 font-mono text-[11px]" style={{ borderColor: "var(--m3-outline-variant)" }}>F5</kbd>
        </button>
        {saved.setups.map((s) => (
          <div key={s.name} className="group flex items-center gap-1">
            <button
              onClick={() => {
                onChange({ ...s.setup });
                notify(`Setup “${s.name}” applied — Play runs it`);
              }}
              className="m3-focus flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left"
              style={{ color: "var(--m3-on-surface-variant)" }}
              title={`Apply “${s.name}”: ${setupSummary(s.setup)}`}
            >
              <MIcon name="bookmark" size={16} />
              <span className="min-w-0 truncate">{s.name} · {setupSummary(s.setup)}</span>
            </button>
            <select
              value={s.shortcut ?? ""}
              onChange={(e) => void persist(withSetup(saved, s.name, s.setup, e.target.value === "" ? null : e.target.value), e.target.value ? `“${s.name}” is on ${e.target.value}` : `“${s.name}” has no key`)}
              aria-label={`Shortcut for ${s.name}`}
              className="h-8 rounded-md border bg-transparent px-1 font-mono text-xs"
              style={{ borderColor: "var(--m3-outline)" }}
            >
              <option value="">no key</option>
              {SETUP_SHORTCUTS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            <button
              onClick={() => void persist(withoutSetup(saved, s.name), `Setup “${s.name}” deleted`)}
              aria-label={`Delete setup ${s.name}`}
              title={`Delete setup ${s.name}`}
              className="m3-focus rounded-full p-1"
            >
              <MIcon name="delete" size={16} />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-1.5 px-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveCurrent();
            }}
            placeholder="Name this setup…"
            aria-label="Setup name"
            className="h-9 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm outline-none"
            style={{ borderColor: "var(--m3-outline)" }}
          />
          <select
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-label="Shortcut for the new setup"
            className="h-9 rounded-md border bg-transparent px-1 font-mono text-xs"
            style={{ borderColor: "var(--m3-outline)" }}
          >
            <option value="">no key</option>
            {SETUP_SHORTCUTS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
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
        onClick={() => {
          onClose();
          onPlay();
        }}
        className="m3-focus mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-full text-sm font-semibold"
        style={{ background: "var(--m3-tertiary-container)", color: "var(--m3-on-tertiary-container)" }}
      >
        <MIcon name="play_arrow" size={20} />
        Play — {whereLabel} · {setup.from === CAMERA ? "camera" : setup.from} · {setup.clients} client{setup.clients === "1" ? "" : "s"}
      </button>
      <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
        Play runs on a working copy of the world and a scratch account file, so your saved world and users.csv stay as they are unless you keep the changes.
      </p>
    </menu>
  );
}

function Label({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>
      {children}
    </p>
  );
}

function Split({ label, options, value, onPick }: { label: string; options: string[]; value: string; onPick: (v: string) => void }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-32 flex-none text-[13px]" style={{ color: "var(--m3-on-surface-variant)" }}>{label}</span>
      <div
        className="flex h-9 flex-1 items-center overflow-hidden rounded-full text-sm"
        role="group"
        aria-label={label}
        style={{ border: "1px solid var(--m3-outline-variant)" }}
      >
        {options.map((o) => {
          const on = value === o;
          return (
            <button
              key={o}
              onClick={() => onPick(o)}
              aria-pressed={on}
              className="m3-focus flex h-full flex-1 items-center justify-center whitespace-nowrap px-2"
              style={on ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
            >
              {o}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Check({ checked, onFlip, label }: { checked: boolean; onFlip: () => void; label: React.ReactNode }): React.JSX.Element {
  return (
    <button onClick={onFlip} role="checkbox" aria-checked={checked} className="m3-focus flex items-center gap-2.5 text-left">
      <span
        className="grid h-5 w-5 flex-none place-items-center rounded-[4px]"
        style={checked ? { background: "var(--m3-primary)", color: "var(--m3-on-primary)" } : { border: "2px solid var(--m3-outline)" }}
      >
        {checked && <MIcon name="check" size={15} />}
      </span>
      <span style={{ color: "var(--m3-on-surface)" }}>{label}</span>
    </button>
  );
}
