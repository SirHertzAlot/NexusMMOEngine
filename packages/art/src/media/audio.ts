/**
 * Audio events as data (content/audio/events.json), and the pure part of
 * the engine that plays them: the document's schema, and the voice pool
 * (per-event and global voice limits, cooldowns, stealing). The Web Audio
 * side is in audio-player.ts.
 *
 * There are no recorded sounds in the repo, so every event is a recipe of
 * generated layers (tones, filtered noise, a looping bed, a drone chord).
 * An event keeps its id and bus when samples replace the recipe.
 */
import { checker, isObj, isNum, type MediaIssue, type Obj } from "./issue.js";

export const AUDIO_BUS_NAMES = ["effects", "interface", "ambience", "music"] as const;
export type AudioBusName = (typeof AUDIO_BUS_NAMES)[number];

export type AudioLayer =
  | { kind: "tone"; wave: OscillatorType; freq: number; glideTo?: number; peak: number; decay: number; at?: number }
  | { kind: "noise"; filter: BiquadFilterType; freq: number; sweepTo?: number; peak: number; decay: number; at?: number }
  /** A looping filtered-noise bed whose level drifts with a slow LFO (wind, rain). */
  | { kind: "bed"; filter: BiquadFilterType; freq: number; q?: number; level: number; lfoHz: number; lfoDepth: number }
  /** A looping chord of oscillators (a music pad). */
  | { kind: "drone"; wave: OscillatorType; freqs: number[]; level: number; lfoHz: number; lfoDepth: number };

export interface AudioEvent {
  bus: AudioBusName;
  layers: AudioLayer[];
  /** Most copies of this event sounding at once (the oldest is cut). Default 4. */
  voices?: number;
  /** Seconds before it may start again. Default 0. */
  cooldown?: number;
  /** Event gain, 0..2. Default 1. */
  gain?: number;
  /** Plays until stopped (beds, music); its layers are beds and drones. */
  loop?: boolean;
  /** Placed in the world when a position is given (3D panning). */
  spatial?: boolean;
}

export interface AudioDoc {
  version: 1;
  /** The mixer's default level per bus (the player's sliders multiply it), 0..1.5. */
  buses: Record<AudioBusName, { gain: number }>;
  /** Most voices sounding at once across all events. */
  maxVoices: number;
  events: Record<string, AudioEvent>;
  /** What the game triggers, by event id. */
  hooks: {
    /** Music by scene name (a flow node's scene; "@assigned" is the world). */
    scene: Record<string, string>;
    /** An ambient bed by weather kind. */
    weather: Record<string, string>;
    /** Footsteps: a step every `stride` metres on the ground; the event by surface layer id (materials.json), else `fallback`. */
    footstep: { stride: number; fallback: string };
    /** Combat: the event for each hit outcome and for starting a swing. */
    combat: Record<string, string>;
  };
}

const WAVES = ["sine", "square", "triangle", "sawtooth"];
const FILTERS = ["lowpass", "highpass", "bandpass"];

export function validateAudio(doc: unknown): MediaIssue[] {
  const c = checker();
  if (!isObj(doc)) return [{ path: "", message: "audio must be an object" }];
  if (doc.version !== 1) c.add("version", "must be 1");
  if (!isObj(doc.buses)) c.add("buses", "must be an object");
  else {
    for (const b of AUDIO_BUS_NAMES) {
      const bus = doc.buses[b];
      if (!isObj(bus)) c.add(`buses.${b}`, "missing");
      else c.num(bus, "gain", `buses.${b}.`, 0, 1.5);
    }
  }
  c.num(doc, "maxVoices", "", 1, 128);
  const events: Record<string, unknown> = isObj(doc.events) ? doc.events : {};
  if (!isObj(doc.events) || Object.keys(events).length === 0) c.add("events", "must be an object with at least one event");
  for (const [id, raw] of Object.entries(events)) {
    const p = `events.${id}.`;
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) c.add(`events.${id}`, "id must be lowercase letters, digits, dots and dashes");
    if (!isObj(raw)) {
      c.add(`events.${id}`, "must be an object");
      continue;
    }
    const e: Obj = raw;
    if (!AUDIO_BUS_NAMES.includes(e.bus as AudioBusName)) c.add(`${p}bus`, `must be one of ${AUDIO_BUS_NAMES.join(", ")}`);
    if (e.voices !== undefined) c.num(e, "voices", p, 1, 32);
    if (e.cooldown !== undefined) c.num(e, "cooldown", p, 0, 60);
    if (e.gain !== undefined) c.num(e, "gain", p, 0, 2);
    for (const k of ["loop", "spatial"]) if (e[k] !== undefined && typeof e[k] !== "boolean") c.add(`${p}${k}`, "must be true or false");
    if (!Array.isArray(e.layers) || e.layers.length === 0) {
      c.add(`${p}layers`, "must be a list with at least one layer");
      continue;
    }
    (e.layers as unknown[]).forEach((rawLayer, i) => {
      const lp = `${p}layers[${i}].`;
      if (!isObj(rawLayer)) return c.add(lp.slice(0, -1), "must be an object");
      const l: Obj = rawLayer;
      const looping = l.kind === "bed" || l.kind === "drone";
      if (l.kind === "tone") {
        if (!WAVES.includes(l.wave as string)) c.add(`${lp}wave`, `must be one of ${WAVES.join(", ")}`);
        c.num(l, "freq", lp, 20, 20000);
        if (l.glideTo !== undefined) c.num(l, "glideTo", lp, 20, 20000);
      } else if (l.kind === "noise") {
        if (!FILTERS.includes(l.filter as string)) c.add(`${lp}filter`, `must be one of ${FILTERS.join(", ")}`);
        c.num(l, "freq", lp, 20, 20000);
        if (l.sweepTo !== undefined) c.num(l, "sweepTo", lp, 20, 20000);
      } else if (l.kind === "bed") {
        if (!FILTERS.includes(l.filter as string)) c.add(`${lp}filter`, `must be one of ${FILTERS.join(", ")}`);
        c.num(l, "freq", lp, 20, 20000);
        if (l.q !== undefined) c.num(l, "q", lp, 0.1, 30);
      } else if (l.kind === "drone") {
        if (!WAVES.includes(l.wave as string)) c.add(`${lp}wave`, `must be one of ${WAVES.join(", ")}`);
        if (!Array.isArray(l.freqs) || l.freqs.length === 0 || l.freqs.length > 8 || !l.freqs.every((f) => isNum(f) && f >= 20 && f <= 20000)) {
          c.add(`${lp}freqs`, "must be 1..8 frequencies in 20..20000 Hz");
        }
      } else c.add(`${lp}kind`, "must be tone, noise, bed or drone");
      if (l.kind === "tone" || l.kind === "noise") {
        c.num(l, "peak", lp, 0, 2);
        c.num(l, "decay", lp, 0.005, 10);
        if (l.at !== undefined) c.num(l, "at", lp, 0, 10);
      } else if (looping) {
        c.num(l, "level", lp, 0, 2);
        c.num(l, "lfoHz", lp, 0, 20);
        c.num(l, "lfoDepth", lp, 0, 2);
      }
      if (e.loop === true && !looping) c.add(`${lp}kind`, "a looping event takes bed and drone layers");
      if (e.loop !== true && looping) c.add(`${lp}kind`, `${String(l.kind)} layers need "loop": true on the event`);
    });
  }
  const hooks = doc.hooks;
  if (!isObj(hooks)) c.add("hooks", "must be an object");
  else {
    const known = (path: string, id: unknown): void => {
      if (typeof id !== "string" || !(id in events)) c.add(path, `no audio event "${String(id)}"`);
    };
    for (const group of ["scene", "weather", "combat"] as const) {
      const g = hooks[group];
      if (!isObj(g)) c.add(`hooks.${group}`, "must be an object");
      else for (const [k, id] of Object.entries(g)) known(`hooks.${group}.${k}`, id);
    }
    if (!isObj(hooks.footstep)) c.add("hooks.footstep", "must be an object");
    else {
      c.num(hooks.footstep, "stride", "hooks.footstep.", 0.2, 10);
      known("hooks.footstep.fallback", hooks.footstep.fallback);
    }
  }
  return c.issues;
}

/** An event id each footstep surface in `materials` names that `audio` doesn't have. */
export function missingFootsteps(surfaces: Record<string, { footstep?: string }>, audio: Pick<AudioDoc, "events">): MediaIssue[] {
  const out: MediaIssue[] = [];
  for (const [id, s] of Object.entries(surfaces)) {
    if (s.footstep !== undefined && !(s.footstep in audio.events)) out.push({ path: `surfaces.${id}.footstep`, message: `no audio event "${s.footstep}"` });
  }
  return out;
}

/** One sounding voice. */
export interface Voice {
  event: string;
  startedAt: number;
  /** When it ends by itself (Infinity for a loop). */
  endsAt: number;
  stop(): void;
}

/**
 * Voice limits: a global cap and a per-event cap (the oldest voice is cut
 * for a new one), plus per-event cooldowns. Time is whatever clock the
 * caller uses, in seconds.
 */
export class VoicePool {
  private voices: Voice[] = [];
  private readonly lastStart = new Map<string, number>();

  constructor(public maxVoices: number) {}

  get active(): readonly Voice[] {
    return this.voices;
  }

  count(event?: string): number {
    return event === undefined ? this.voices.length : this.voices.filter((v) => v.event === event).length;
  }

  /**
   * Make room for `event` starting at `now`. Returns false when its cooldown
   * hasn't passed (nothing is cut); otherwise cuts whatever the limits
   * require and returns true. Call `add` once the voice exists.
   */
  admit(event: string, now: number, limits: { voices?: number; cooldown?: number }): boolean {
    this.voices = this.voices.filter((v) => v.endsAt > now);
    const last = this.lastStart.get(event);
    if (last !== undefined && now - last < (limits.cooldown ?? 0)) return false;
    const perEvent = limits.voices ?? 4;
    const same = this.voices.filter((v) => v.event === event);
    for (let i = 0; i <= same.length - perEvent; i++) this.cut(same[i]);
    while (this.voices.length >= this.maxVoices) this.cut(this.voices[0]);
    return true;
  }

  add(voice: Voice): void {
    this.voices.push(voice);
    this.lastStart.set(voice.event, voice.startedAt);
  }

  stopAll(event?: string): void {
    for (const v of [...this.voices]) if (event === undefined || v.event === event) this.cut(v);
  }

  private cut(v: Voice): void {
    this.voices = this.voices.filter((x) => x !== v);
    v.stop();
  }
}
