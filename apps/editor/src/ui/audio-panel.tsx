/**
 * Audio panel (EA24, Art & audio): browse the sound events of
 * content/audio/events.json, audition them with the game client's own
 * engine (placeholder tones until recordings exist), and edit the buses'
 * mixer settings and each event's bus, volume, 3D range, pitch, priority
 * and variations. Save goes through the dev host, which validates with the
 * server's schema.
 */

import * as React from "react";
import { AudioEngine, DEFAULT_VOLUMES, EVENT_BUSES, parseAudioBank, type EventBus, type SoundBank } from "@mmo-engine/client/audio";
import { getAudio, saveAudio } from "../audio-client.js";
import { addClip, addEvent, clipsOf, patchEvent, problems, removeClip, removeEvent, setBus, setClip, toDocument } from "../audio-doc.js";
import { Button, CheckField, Field, Input, MIcon, NumberInput, Select } from "./components.js";
import { DocBar } from "./doc-bar.js";
import { NO_HISTORY, useDocActions } from "./doc-actions.js";
import { useSaveTask } from "./use-save-task.js";

/** Where the audition listener stands: the origin, facing -z. */
const EAR = { x: 0, y: 0, z: 0, fx: 0, fz: -1 };
const serialize = (bank: SoundBank): string => JSON.stringify(toDocument(bank));

export function AudioPanel(): React.JSX.Element {
  const [bank, setBank] = React.useState<SoundBank | null>(null);
  const [saved, setSaved] = React.useState("");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [distance, setDistance] = React.useState(5);
  const [side, setSide] = React.useState(0);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [voices, setVoices] = React.useState<Record<EventBus, number>>({ master: 0, combat: 0, interface: 0, ambience: 0 });
  const [lastPlay, setLastPlay] = React.useState("");
  const task = useSaveTask();
  const engine = React.useRef<AudioEngine | null>(null);
  engine.current ??= new AudioEngine(DEFAULT_VOLUMES);

  const load = React.useCallback((): void => {
    setLoadError(null);
    getAudio().then(
      (raw) => {
        const { bank: b, errors } = parseAudioBank(raw);
        setBank(b);
        setSaved(serialize(b));
        setSelected((cur) => (cur && b.events.some((e) => e.name === cur) ? cur : (b.events[0]?.name ?? null)));
        task.clear();
        if (errors.length > 0) task.setStatus({ tone: "info", text: `Dropped on load: ${errors.join("; ")}` });
      },
      (e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(load, [load]);

  // The engine plays what is on screen, edits included.
  React.useEffect(() => {
    if (bank) engine.current?.setBank(bank);
    engine.current?.setListener(EAR);
  }, [bank]);
  React.useEffect(() => {
    const t = window.setInterval(() => {
      const e = engine.current;
      if (e) setVoices({ master: e.voices("master"), combat: e.voices("combat"), interface: e.voices("interface"), ambience: e.voices("ambience") });
    }, 200);
    return () => window.clearInterval(t);
  }, []);

  const dirty = bank !== null && serialize(bank) !== saved;
  const issues = bank ? problems(bank) : [];
  const save = async (): Promise<void> => {
    if (bank && (await task.run(() => saveAudio(toDocument(bank)), { ok: "saved to content/audio/events.json" }))) setSaved(serialize(bank));
  };
  const revert = (): void => {
    if (saved) setBank(parseAudioBank(JSON.parse(saved)).bank);
  };

  // Toolbar Save while the document is open (edits apply directly: no undo stack).
  useDocActions(() => {
    if (!bank) return null;
    return {
      label: "audio events",
      canSave: dirty && issues.length === 0,
      ...NO_HISTORY,
      problems: issues.map((i) => ({ severity: "error" as const, where: i.event || "(audio)", message: i.message })),
      save: () => void save(),
    };
  });

  if (!bank) {
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-[13px]">
        <p>Audio: {loadError ?? "loading…"}</p>
        {loadError && <Button size="sm" variant="outline" onClick={load}>Retry</Button>}
      </div>
    );
  }

  const event = bank.events.find((e) => e.name === selected) ?? null;
  const audition = async (name: string, file?: string): Promise<void> => {
    const eng = engine.current!;
    await eng.unlock();
    const e = bank.events.find((x) => x.name === name)!;
    const ok = eng.playEvent(name, e.positional ? { x: side * distance, y: 0, z: -Math.sqrt(Math.max(0, 1 - side * side)) * distance } : null, file);
    setLastPlay(ok ? `played ${file ?? name}` : eng.ready ? `${name}: nothing played (out of range or the bus is full)` : "no audio output available");
  };
  const edit = (next: SoundBank): void => {
    setBank(next);
    task.setIssues([]);
  };
  const patch = (p: Parameters<typeof patchEvent>[2]): void => {
    if (event) edit(patchEvent(bank, event.name, p));
  };
  const rename = (name: string): void => {
    if (!event) return;
    edit(patchEvent(bank, event.name, { name }));
    setSelected(name);
  };

  return (
    <div className="flex flex-col gap-3 p-3" style={{ color: "var(--m3-on-surface)" }}>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-mono" style={{ color: "var(--m3-on-surface-variant)" }}>content/audio/events.json</span>
        <span>{bank.events.length} events</span>
        <span style={{ color: issues.length ? "#E8A33D" : "#6FCF97" }}>{issues.length ? `${issues.length} problem${issues.length === 1 ? "" : "s"}` : "valid"}</span>
        <span className="ml-auto flex items-center gap-2">
          {dirty && <span style={{ color: "#E8A33D" }}>unsaved</span>}
          <DocBar dirty={dirty} busy={task.busy} saveBlocked={issues.length > 0} onSave={() => void save()} onRevert={revert} />
        </span>
      </div>
      {task.status && <div className="text-[12px]" role="status" style={{ color: task.status.tone === "bad" ? "#FFB4AB" : "var(--m3-on-surface-variant)" }}>{task.status.text}</div>}
      {issues.length > 0 && (
        <ul className="rounded-xl px-3 py-2 text-[12px]" style={{ background: "rgba(232,163,61,.14)", color: "#E8A33D" }} aria-label="audio problems">
          {issues.map((i, k) => <li key={k}>{i.message}</li>)}
        </ul>
      )}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[220px_1fr_280px]">
        <div className="rounded-xl p-2" style={{ background: "var(--m3-surface-2)" }} role="listbox" aria-label="Sound events">
          {bank.events.map((e) => {
            const on = e.name === selected;
            return (
              <button
                key={e.name}
                role="option"
                aria-selected={on}
                onClick={() => setSelected(e.name)}
                className="m3-focus flex h-8 w-full items-center gap-2 rounded-full px-3 font-mono text-xs"
                style={on ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
              >
                <MIcon name="audio_file" size={15} />{e.name}
                <span className="ml-auto" style={{ color: "var(--m3-on-surface-variant)" }}>{e.bus}</span>
              </button>
            );
          })}
          <div className="mt-2 flex gap-1.5 px-1">
            <Button size="sm" variant="outline" onClick={() => { const r = addEvent(bank); edit(r.bank); setSelected(r.name); }}>Add event</Button>
            <Button size="sm" variant="ghost" disabled={!event} onClick={() => { if (event) { edit(removeEvent(bank, event.name)); setSelected(null); } }}>Delete</Button>
          </div>
        </div>

        {event ? (
          <div className="flex flex-col gap-3 rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void audition(event.name)}>Play {event.name}</Button>
              <span className="text-[12px]" style={{ color: "var(--m3-on-surface-variant)" }} role="status" aria-label="Last audition">{lastPlay}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <Field label="Name"><Input className="h-9" value={event.name} onChange={(e) => rename(e.target.value)} /></Field>
              <Field label="Bus">
                <Select size="md" value={event.bus} onChange={(e) => patch({ bus: e.target.value as EventBus })}>
                  {EVENT_BUSES.map((b) => <option key={b}>{b}</option>)}
                </Select>
              </Field>
              <Field label="Volume (0–1)"><NumberInput min={0} max={1} step={0.05} value={event.volume} onChange={(v) => patch({ volume: v })} /></Field>
              <Field label="Priority (0–10)"><NumberInput min={0} max={10} step={1} value={event.priority} onChange={(v) => patch({ priority: v })} /></Field>
              <Field label="Pitch min"><NumberInput min={0.25} max={4} step={0.05} value={event.pitchRange[0]} onChange={(v) => patch({ pitchRange: [v, event.pitchRange[1]] })} /></Field>
              <Field label="Pitch max"><NumberInput min={0.25} max={4} step={0.05} value={event.pitchRange[1]} onChange={(v) => patch({ pitchRange: [event.pitchRange[0], v] })} /></Field>
              <Field label="Max distance (m)"><NumberInput min={1} step={1} disabled={!event.positional} value={event.maxDistance} onChange={(v) => patch({ maxDistance: v })} /></Field>
              <div className="flex items-end pb-2"><CheckField label="Positional (3D)" checked={event.positional} onChange={(positional) => patch({ positional })} /></div>
            </div>

            <div>
              <p className="mb-1 text-[11px] text-muted-foreground">Clips{clipsOf(event).length > 1 ? " (weighted variations)" : ""}</p>
              {clipsOf(event).map((c, i) => (
                <div key={i} className="mb-1.5 flex items-center gap-2">
                  <Button size="sm" variant="ghost" aria-label={`Play ${c.file}`} onClick={() => void audition(event.name, c.file)}><MIcon name="play_circle" size={18} /></Button>
                  <div className="min-w-0 flex-1"><Input className="font-mono" aria-label={`Clip ${i + 1} file`} value={c.file} onChange={(e) => edit(setClip(bank, event.name, i, { file: e.target.value }))} /></div>
                  {clipsOf(event).length > 1 && (
                    <div className="w-20 flex-none"><NumberInput aria-label={`Clip ${i + 1} weight`} min={0} step={1} value={c.weight} onChange={(w) => edit(setClip(bank, event.name, i, { weight: w }))} /></div>
                  )}
                  <Button size="sm" variant="ghost" aria-label={`Remove clip ${i + 1}`} disabled={clipsOf(event).length <= 1} onClick={() => edit(removeClip(bank, event.name, i))}><MIcon name="close" size={16} /></Button>
                </div>
              ))}
              <Button size="sm" variant="outline" onClick={() => edit(addClip(bank, event.name))}>Add variation</Button>
              <p className="mt-1 text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>Placeholder tones stand in for the files until recordings exist; the file name picks the sound.</p>
            </div>

            {event.positional && (
              <div className="grid grid-cols-2 gap-2">
                <Field label={`Audition distance: ${distance} m`}>
                  <input type="range" min={0} max={Math.max(event.maxDistance * 1.25, 2)} step={0.5} value={distance} onChange={(e) => setDistance(Number(e.target.value))} />
                </Field>
                <Field label={`Audition side: ${side < -0.2 ? "left" : side > 0.2 ? "right" : "ahead"}`}>
                  <input type="range" min={-1} max={1} step={0.1} value={side} onChange={(e) => setSide(Number(e.target.value))} />
                </Field>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-xl p-3 text-[13px]" style={{ background: "var(--m3-surface-2)" }}>Pick an event, or add one.</div>
        )}

        <div className="flex flex-col gap-3 rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
          <p className="text-sm font-medium">Mixer</p>
          {EVENT_BUSES.map((b) => (
            <div key={b} className="rounded-lg p-2" style={{ background: "var(--m3-surface-1)" }}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="font-medium">{b}</span>
                <span className="font-mono" style={{ color: "var(--m3-on-surface-variant)" }} aria-label={`${b} voices playing`}>{voices[b]} / {bank.buses[b].maxVoices} voices</span>
              </div>
              <Field label={`Gain ${bank.buses[b].gain.toFixed(2)}`}>
                <input type="range" aria-label={`${b} gain`} min={0} max={1} step={0.05} value={bank.buses[b].gain} onChange={(e) => edit(setBus(bank, b, { gain: Number(e.target.value) }))} />
              </Field>
              <Field label="Max voices"><NumberInput aria-label={`${b} max voices`} min={1} max={64} step={1} value={bank.buses[b].maxVoices} onChange={(v) => edit(setBus(bank, b, { maxVoices: v }))} /></Field>
            </div>
          ))}
          <p className="text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>Bus gain is the designer's mix; the player's sliders in Settings sit on top. When a bus is full, a higher-priority sound steals the weakest voice.</p>
        </div>
      </div>
    </div>
  );
}
