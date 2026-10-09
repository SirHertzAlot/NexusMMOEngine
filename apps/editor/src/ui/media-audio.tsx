/**
 * Audio workspace (roadmap EA24): the events, the mixer and the hooks,
 * over content/audio/events.json, with the same engine the client plays
 * them with (@mmo-engine/art's AudioMixer: buses, voice limits, 3D
 * panning). There are no recorded sounds in the repo, so every event is
 * a recipe of generated layers; Preview plays it for real.
 *
 *  - Events: edit an event's bus, voice limit, cooldown, gain, loop and
 *    layers; Preview, Fire x12 (to hear the voice limit cut the oldest),
 *    and a position slider to hear the panning.
 *  - Mixer: the bus gains (the mixer's defaults; the player's sliders sit
 *    on top), the global voice limit, a level meter and the live voice count.
 *  - Hooks: which event plays for a scene's music, the weather's bed, a
 *    footstep on each surface, and each combat outcome.
 */
import * as React from "react";
import {
  AUDIO_BUS_NAMES, AudioMixer,
  type AudioBusName, type AudioDoc, type AudioEvent, type AudioLayer, type MaterialsDoc,
} from "@mmo-engine/art/browser";
import { getMedia } from "../media-client.js";
import { H, Num, Pick, SaveBar, Segmented, Text, Toggle, btn, mediaStore, muted, useMediaDoc, usePublish, useSaveAction } from "./media-common.js";
import { detailStore } from "./media-details.js";

const WAVES = ["sine", "square", "triangle", "sawtooth"] as const;
const FILTERS = ["lowpass", "highpass", "bandpass"] as const;

/** A fresh layer of a kind, with a sound that is audible as it stands. */
export function newLayer(kind: AudioLayer["kind"]): AudioLayer {
  switch (kind) {
    case "tone": return { kind, wave: "sine", freq: 440, peak: 0.4, decay: 0.3 };
    case "noise": return { kind, filter: "bandpass", freq: 1200, peak: 0.4, decay: 0.2 };
    case "bed": return { kind, filter: "bandpass", freq: 420, q: 0.6, level: 0.15, lfoHz: 0.1, lfoDepth: 0.08 };
    case "drone": return { kind, wave: "sine", freqs: [110, 165], level: 0.3, lfoHz: 0.1, lfoDepth: 0.3 };
  }
}

/** The editor's own audio context and mixer, made on the first click (browsers need a gesture). */
function useMixer(doc: AudioDoc | null): { mixer: AudioMixer | null; analyser: AnalyserNode | null; start: () => void } {
  const [state, setState] = React.useState<{ mixer: AudioMixer; analyser: AnalyserNode } | null>(null);
  const latest = React.useRef(doc);
  latest.current = doc;
  const start = React.useCallback((): void => {
    if (state || !latest.current || typeof AudioContext === "undefined") return;
    const ctx = new AudioContext();
    const mixer = new AudioMixer(ctx, latest.current);
    mixer.setPlayerGain("master", 0.8, true);
    for (const b of AUDIO_BUS_NAMES) mixer.setPlayerGain(b, 0.8, true);
    mixer.setListener([0, 0, 0], [0, 0, -1]);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    mixer.master.connect(analyser);
    setState({ mixer, analyser });
  }, [state]);
  React.useEffect(() => {
    if (state && doc) state.mixer.setDoc(doc);
  }, [state, doc]);
  React.useEffect(() => () => {
    if (state) {
      state.mixer.stopAll();
      void (state.mixer.ctx as AudioContext).close?.();
    }
  }, [state]);
  return { mixer: state?.mixer ?? null, analyser: state?.analyser ?? null, start };
}

export function AudioPanel(): React.JSX.Element {
  const audio = useMediaDoc("audio");
  const [tab, setTab] = React.useState<"events" | "mixer" | "hooks">("events");
  const { mixer, analyser, start } = useMixer(audio.doc);
  const [materials, setMaterials] = React.useState<MaterialsDoc | null>(null);
  useSaveAction("audio events", [audio]);
  usePublish({ events: audio.doc ? Object.entries(audio.doc.events).map(([id, e]): [string, string] => [id, e.bus]) : [] });
  React.useEffect(() => {
    getMedia("materials").then(setMaterials).catch(() => setMaterials(null));
  }, []);
  return (
    <div className="flex flex-col gap-3 p-3" style={{ color: "var(--m3-on-surface)" }}>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="Audio views" value={tab} onChange={setTab} options={[["events", "Events"], ["mixer", "Mixer"], ["hooks", "Hooks"]]} />
        {!mixer && <button className={btn} style={{ background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }} onClick={start}>Enable audio preview</button>}
        {mixer && <span className="text-[12px]" style={{ color: "#6FCF97" }}>audio preview on ({mixer.ctx.sampleRate} Hz)</span>}
      </div>
      <SaveBar file="content/audio/events.json" dirty={audio.dirty} issues={audio.issues} status={audio.status} onSave={() => void audio.save()} onRevert={audio.revert} />
      {audio.doc && tab === "events" && <EventsEditor doc={audio.doc} mixer={mixer} onChange={audio.set} />}
      {audio.doc && tab === "mixer" && <Mixer doc={audio.doc} mixer={mixer} analyser={analyser} onChange={audio.set} />}
      {audio.doc && tab === "hooks" && <Hooks doc={audio.doc} mixer={mixer} materials={materials} onChange={audio.set} />}
      {!audio.doc && <p className="text-[13px]" style={muted}>{audio.status || "loading…"}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- events

function EventsEditor({ doc, mixer, onChange }: { doc: AudioDoc; mixer: AudioMixer | null; onChange: (d: AudioDoc) => void }): React.JSX.Element {
  const { event: picked } = mediaStore.use();
  const ids = Object.keys(doc.events);
  const id = doc.events[picked] ? picked : ids[0];
  const ev = doc.events[id];
  const [x, setX] = React.useState(0);
  const [voices, setVoices] = React.useState(0);
  React.useEffect(() => {
    if (!mixer) return;
    const t = setInterval(() => setVoices(mixer.pool.count(id)), 100);
    return () => clearInterval(t);
  }, [mixer, id]);
  React.useEffect(() => {
    const used = Object.entries(doc.hooks).flatMap(([group, map]) => (group === "footstep" ? [] : Object.entries(map as Record<string, string>).filter(([, e]) => e === id).map(([k]) => `${group}: ${k}`)));
    detailStore.set({
      title: id,
      rows: [
        ["bus", ev.bus], ["voices", String(ev.voices ?? 4)], ["cooldown", `${ev.cooldown ?? 0} s`], ["gain", String(ev.gain ?? 1)],
        ["kind", `${ev.loop ? "loops" : "one-shot"}${ev.spatial ? ", 3D" : ""}`], ["layers", String(ev.layers.length)], ["hooked to", used.join(" · ") || "no hook"],
      ],
      note: "Recipes of generated tones until recorded samples replace them; the event id and bus stay.",
    });
  });
  const set = (patch: Partial<AudioEvent>): void => onChange({ ...doc, events: { ...doc.events, [id]: { ...ev, ...patch } } });
  const setLayer = (i: number, layer: AudioLayer): void => set({ layers: ev.layers.map((l, k) => (k === i ? layer : l)) });
  const play = (n = 1): void => {
    for (let i = 0; i < n; i++) setTimeout(() => mixer?.play(id, ev.spatial ? { position: [x, 0, -5] } : undefined), i * 40);
  };
  const playing = React.useRef<{ stop: (fade?: number) => void } | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Pick label="Event" value={id} options={ids} onChange={(v) => mediaStore.set((p) => ({ ...p, event: v }))} />
        <NewEvent doc={doc} sourceId={id} onAdd={(name) => { onChange({ ...doc, events: { ...doc.events, [name]: structuredClone(ev) } }); mediaStore.set((p) => ({ ...p, event: name })); }} />
        <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} disabled={ids.length < 2} onClick={() => onChange({ ...doc, events: Object.fromEntries(Object.entries(doc.events).filter(([k]) => k !== id)) })}>Delete event</button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Pick label="Bus" value={ev.bus} options={AUDIO_BUS_NAMES} onChange={(bus) => set({ bus })} />
        <Num label="Voices at once" value={ev.voices ?? 4} min={1} max={32} step={1} onChange={(v) => set({ voices: v })} />
        <Num label="Cooldown" unit="s" value={ev.cooldown ?? 0} min={0} max={60} step={0.01} onChange={(cooldown) => set({ cooldown })} />
        <Num label="Gain" value={ev.gain ?? 1} min={0} max={2} step={0.05} onChange={(gain) => set({ gain })} />
        <Toggle label="Loops until stopped" value={ev.loop === true} onChange={(loop) => set({ loop, layers: loop ? [newLayer("bed")] : [newLayer("tone")] })} />
        <Toggle label="3D position" value={ev.spatial === true} onChange={(spatial) => set({ spatial })} />
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
        <button className={btn} disabled={!mixer} title={mixer ? undefined : "Enable audio preview first"} style={{ background: "var(--m3-primary)", color: "var(--m3-on-primary)", opacity: mixer ? 1 : 0.5 }} onClick={() => {
          if (ev.loop && mixer) {
            if (playing.current) {
              playing.current.stop();
              playing.current = null;
            } else playing.current = mixer.play(id);
          } else play();
        }}>{ev.loop ? "Preview / stop" : "Preview"}</button>
        {!ev.loop && <button className={btn} disabled={!mixer} style={{ border: "1px solid var(--m3-outline-variant)" }} onClick={() => play(12)}>Fire x12 (voice limit)</button>}
        {ev.spatial && (
          <label className="flex items-center gap-2 text-[12px]" style={muted}>
            Position (left to right)
            <input type="range" min={-20} max={20} step={1} value={x} aria-label="Preview position" onChange={(e) => setX(Number(e.target.value))} />
            <span className="w-10 font-mono">{x} m</span>
          </label>
        )}
        <span className="ml-auto font-mono text-[12px]" aria-label="voices sounding">{mixer ? `${voices} voice${voices === 1 ? "" : "s"} of this event (limit ${ev.voices ?? 4})` : "audio preview is off"}</span>
      </div>
      <H>Layers</H>
      {ev.layers.map((l, i) => (
        <LayerRow key={i} layer={l} loop={ev.loop === true} onChange={(nl) => setLayer(i, nl)} onRemove={() => set({ layers: ev.layers.filter((_, k) => k !== i) })} canRemove={ev.layers.length > 1} i={i} />
      ))}
      <div className="flex gap-2">
        {(ev.loop ? (["bed", "drone"] as const) : (["tone", "noise"] as const)).map((k) => (
          <button key={k} className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} onClick={() => set({ layers: [...ev.layers, newLayer(k)] })}>Add {k}</button>
        ))}
      </div>
    </div>
  );
}

function NewEvent({ doc, sourceId, onAdd }: { doc: AudioDoc; sourceId: string; onAdd: (name: string) => void }): React.JSX.Element {
  const [name, setName] = React.useState("");
  const ok = /^[a-z0-9][a-z0-9.-]*$/.test(name) && !(name in doc.events);
  return (
    <span className="flex items-end gap-1">
      <Text label={`New event (copy of ${sourceId})`} value={name} onChange={setName} />
      <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} disabled={!ok} onClick={() => { onAdd(name); setName(""); }}>Add</button>
    </span>
  );
}

function LayerRow({ layer: l, loop, onChange, onRemove, canRemove, i }: { layer: AudioLayer; loop: boolean; onChange: (l: AudioLayer) => void; onRemove: () => void; canRemove: boolean; i: number }): React.JSX.Element {
  const p = `layer ${i + 1} `;
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg p-2" style={{ background: "var(--m3-surface-1)" }} data-layer={i}>
      <span className="w-14 text-[12px] font-semibold">{l.kind}</span>
      {l.kind === "tone" && (
        <>
          <Pick label={`${p}wave`} value={l.wave} options={WAVES} onChange={(wave) => onChange({ ...l, wave })} />
          <Num label={`${p}freq`} unit="Hz" value={l.freq} min={20} max={20000} step={10} onChange={(freq) => onChange({ ...l, freq })} />
          <Num label={`${p}glide to`} unit="Hz" value={l.glideTo ?? NaN} min={20} max={20000} step={10} onChange={(glideTo) => onChange({ ...l, glideTo })} />
          <Num label={`${p}peak`} value={l.peak} min={0} max={2} step={0.05} onChange={(peak) => onChange({ ...l, peak })} />
          <Num label={`${p}decay`} unit="s" value={l.decay} min={0.005} max={10} step={0.01} onChange={(decay) => onChange({ ...l, decay })} />
          <Num label={`${p}delay`} unit="s" value={l.at ?? 0} min={0} max={10} step={0.01} onChange={(at) => onChange({ ...l, at })} />
        </>
      )}
      {l.kind === "noise" && (
        <>
          <Pick label={`${p}filter`} value={l.filter} options={FILTERS} onChange={(filter) => onChange({ ...l, filter })} />
          <Num label={`${p}freq`} unit="Hz" value={l.freq} min={20} max={20000} step={50} onChange={(freq) => onChange({ ...l, freq })} />
          <Num label={`${p}sweep to`} unit="Hz" value={l.sweepTo ?? NaN} min={20} max={20000} step={50} onChange={(sweepTo) => onChange({ ...l, sweepTo })} />
          <Num label={`${p}peak`} value={l.peak} min={0} max={2} step={0.05} onChange={(peak) => onChange({ ...l, peak })} />
          <Num label={`${p}decay`} unit="s" value={l.decay} min={0.005} max={10} step={0.01} onChange={(decay) => onChange({ ...l, decay })} />
          <Num label={`${p}delay`} unit="s" value={l.at ?? 0} min={0} max={10} step={0.01} onChange={(at) => onChange({ ...l, at })} />
        </>
      )}
      {l.kind === "bed" && (
        <>
          <Pick label={`${p}filter`} value={l.filter} options={FILTERS} onChange={(filter) => onChange({ ...l, filter })} />
          <Num label={`${p}freq`} unit="Hz" value={l.freq} min={20} max={20000} step={20} onChange={(freq) => onChange({ ...l, freq })} />
          <Num label={`${p}Q`} value={l.q ?? 0.6} min={0.1} max={30} step={0.1} onChange={(q) => onChange({ ...l, q })} />
          <Num label={`${p}level`} value={l.level} min={0} max={2} step={0.01} onChange={(level) => onChange({ ...l, level })} />
          <Num label={`${p}drift rate`} unit="Hz" value={l.lfoHz} min={0} max={20} step={0.01} onChange={(lfoHz) => onChange({ ...l, lfoHz })} />
          <Num label={`${p}drift depth`} value={l.lfoDepth} min={0} max={2} step={0.01} onChange={(lfoDepth) => onChange({ ...l, lfoDepth })} />
        </>
      )}
      {l.kind === "drone" && (
        <>
          <Pick label={`${p}wave`} value={l.wave} options={WAVES} onChange={(wave) => onChange({ ...l, wave })} />
          <Text label={`${p}notes (Hz, comma separated)`} wide value={l.freqs.join(", ")} onChange={(t) => onChange({ ...l, freqs: t.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0) })} />
          <Num label={`${p}level`} value={l.level} min={0} max={2} step={0.01} onChange={(level) => onChange({ ...l, level })} />
          <Num label={`${p}drift rate`} unit="Hz" value={l.lfoHz} min={0} max={20} step={0.01} onChange={(lfoHz) => onChange({ ...l, lfoHz })} />
          <Num label={`${p}drift depth`} value={l.lfoDepth} min={0} max={2} step={0.01} onChange={(lfoDepth) => onChange({ ...l, lfoDepth })} />
        </>
      )}
      <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} disabled={!canRemove} aria-label={`Remove layer ${i + 1}`} onClick={onRemove}>Remove</button>
      {loop && l.kind !== "bed" && l.kind !== "drone" && <span className="text-[11px]" style={{ color: "#E8A33D" }}>a looping event takes bed and drone layers</span>}
    </div>
  );
}

// ---------------------------------------------------------------- mixer

function Mixer({ doc, mixer, analyser, onChange }: { doc: AudioDoc; mixer: AudioMixer | null; analyser: AnalyserNode | null; onChange: (d: AudioDoc) => void }): React.JSX.Element {
  const [level, setLevel] = React.useState(0);
  const [voices, setVoices] = React.useState(0);
  React.useEffect(() => {
    if (!analyser || !mixer) return;
    const buf = new Float32Array(analyser.fftSize);
    let raf = 0;
    const tick = (): void => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      setLevel(Math.sqrt(sum / buf.length));
      setVoices(mixer.pool.count());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analyser, mixer]);
  React.useEffect(() => {
    detailStore.set({
      title: "Mixer",
      rows: [...AUDIO_BUS_NAMES.map((b): [string, string] => [b, `gain ${doc.buses[b].gain}`]), ["voice limit", String(doc.maxVoices)]],
      note: "These are the mixer's default levels. The player's settings sliders multiply them.",
    });
  });
  const events = Object.entries(doc.events);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-6 rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
        {AUDIO_BUS_NAMES.map((b: AudioBusName) => (
          <div key={b} className="flex flex-col items-center gap-1" data-bus={b}>
            <input
              type="range" min={0} max={1.5} step={0.05} value={doc.buses[b].gain} aria-label={`${b} bus gain`}
              style={{ writingMode: "vertical-lr", direction: "rtl", height: 120 }}
              onChange={(e) => onChange({ ...doc, buses: { ...doc.buses, [b]: { gain: Number(e.target.value) } } })}
            />
            <span className="text-[12px] font-semibold">{b}</span>
            <span className="font-mono text-[11px]" style={muted}>{doc.buses[b].gain.toFixed(2)} · {events.filter(([, e]) => e.bus === b).length} events</span>
            <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} disabled={!mixer} onClick={() => mixer?.pool.stopAll()}>Silence</button>
          </div>
        ))}
        <div className="flex flex-col gap-1">
          <span className="text-[11px]" style={muted}>master level</span>
          <div className="h-3 w-48 rounded" style={{ background: "var(--m3-surface-0)" }} role="meter" aria-label="master level" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded" style={{ width: `${Math.min(100, level * 300)}%`, background: level > 0.5 ? "#E8A33D" : "#6FCF97" }} />
          </div>
          <span className="font-mono text-[12px]">{mixer ? `${voices} voices of ${doc.maxVoices}` : "audio preview is off"}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Num label="Voice limit (all events)" value={doc.maxVoices} min={1} max={128} step={1} onChange={(maxVoices) => onChange({ ...doc, maxVoices })} />
      </div>
      <H>Events by bus</H>
      <table className="w-full text-left text-[12px]" aria-label="events by bus">
        <thead style={muted}><tr><th className="py-1">Event</th><th>Bus</th><th>Voices</th><th>Cooldown</th><th>Gain</th><th>Kind</th></tr></thead>
        <tbody>
          {events.map(([id, e]) => (
            <tr key={id} className="cursor-pointer" onClick={() => mediaStore.set((p) => ({ ...p, event: id }))}>
              <td className="py-0.5 font-mono">{id}</td><td>{e.bus}</td><td>{e.voices ?? 4}</td><td>{e.cooldown ?? 0}</td><td>{e.gain ?? 1}</td><td>{e.loop ? "loop" : "one-shot"}{e.spatial ? " · 3D" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- hooks

function Hooks({ doc, mixer, materials, onChange }: { doc: AudioDoc; mixer: AudioMixer | null; materials: MaterialsDoc | null; onChange: (d: AudioDoc) => void }): React.JSX.Element {
  const ids = Object.keys(doc.events);
  const loops = ids.filter((i) => doc.events[i].loop);
  const hook = <K extends "scene" | "weather" | "combat">(group: K, key: string, options: string[]): React.ReactNode => (
    <Pick key={`${group}.${key}`} label={`${group}: ${key}`} value={doc.hooks[group][key]} options={options} onChange={(v) => onChange({ ...doc, hooks: { ...doc.hooks, [group]: { ...doc.hooks[group], [key]: v } } })} />
  );
  const surfaces = materials ? Object.entries(materials.surfaces) : [];
  const [surface, setSurface] = React.useState("");
  const stepFor = (sid: string): string => materials?.surfaces[sid]?.footstep ?? doc.hooks.footstep.fallback;
  React.useEffect(() => {
    detailStore.set({
      title: "Hooks",
      rows: [["scenes", String(Object.keys(doc.hooks.scene).length)], ["weather beds", String(Object.keys(doc.hooks.weather).length)], ["stride", `${doc.hooks.footstep.stride} m`], ["surfaces", String(surfaces.length)]],
      note: "A scene's music follows the game flow; the bed follows the weather where the player stands; footsteps follow the terrain surface (set per surface in Materials).",
    });
  });
  return (
    <div className="flex flex-col gap-3">
      <H>Music by scene</H>
      <div className="flex flex-wrap items-end gap-3">{Object.keys(doc.hooks.scene).map((k) => hook("scene", k, loops))}</div>
      <H>Ambient bed by weather</H>
      <div className="flex flex-wrap items-end gap-3">{Object.keys(doc.hooks.weather).map((k) => hook("weather", k, loops))}</div>
      <H>Combat outcomes</H>
      <div className="flex flex-wrap items-end gap-3">{Object.keys(doc.hooks.combat).map((k) => hook("combat", k, ids.filter((i) => !doc.events[i].loop)))}</div>
      <H>Footsteps</H>
      <div className="flex flex-wrap items-end gap-3">
        <Num label="Stride" unit="m" value={doc.hooks.footstep.stride} min={0.2} max={10} step={0.1} onChange={(stride) => onChange({ ...doc, hooks: { ...doc.hooks, footstep: { ...doc.hooks.footstep, stride } } })} />
        <Pick label="Fallback step" value={doc.hooks.footstep.fallback} options={ids.filter((i) => !doc.events[i].loop)} onChange={(fallback) => onChange({ ...doc, hooks: { ...doc.hooks, footstep: { ...doc.hooks.footstep, fallback } } })} />
        <Pick label="Surface" value={surface || surfaces[0]?.[0] || ""} options={surfaces.map(([s]) => s)} onChange={setSurface} />
        <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} disabled={!mixer} onClick={() => mixer?.play(stepFor(surface || surfaces[0]?.[0] || ""), { position: [0, 0, -2] })}>
          Step on {surface || surfaces[0]?.[0] || "?"}
        </button>
      </div>
      <p className="text-[12px]" style={muted}>Each surface's footstep event is set under VFX, Materials, Surfaces.</p>
    </div>
  );
}
