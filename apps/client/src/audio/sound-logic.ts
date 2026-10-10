/**
 * Sound logic (EA24): everything about playing an audio event that needs no
 * audio device. Which variation plays, how loud and how far to one side a
 * positional sound is, and which voice goes when a bus is full. The Web
 * Audio graph (sound-engine.ts) only applies the numbers computed here.
 *
 * The shapes mirror engine-core's `AudioBank` schema (the editor host
 * validates every save with it); `parseAudioBank` here is the client's
 * lenient reader: an event that does not parse is dropped and reported,
 * never allowed to take the rest of the bank down with it.
 */

export const EVENT_BUSES = ["master", "combat", "interface", "ambience"] as const;
export type EventBus = (typeof EVENT_BUSES)[number];

export interface Variation {
  file: string;
  weight: number;
}

export interface SoundEvent {
  name: string;
  bus: EventBus;
  file?: string;
  variations?: Variation[];
  volume: number;
  positional: boolean;
  maxDistance: number;
  pitchRange: [number, number];
  priority: number;
}

export interface BusSettings {
  gain: number;
  maxVoices: number;
}

export interface SoundBank {
  buses: Record<EventBus, BusSettings>;
  events: SoundEvent[];
}

export const DEFAULT_BUS: BusSettings = { gain: 1, maxVoices: 16 };

const num = (v: unknown, fallback: number, lo: number, hi: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** One event from JSON, or the reason it cannot be used. */
export function parseSoundEvent(raw: unknown): SoundEvent | string {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const name = typeof o.name === "string" ? o.name : "";
  if (!name) return "an event has no name";
  if (!(EVENT_BUSES as readonly unknown[]).includes(o.bus)) return `${name}: unknown bus`;
  const variations = Array.isArray(o.variations)
    ? o.variations.flatMap((v: unknown) => {
        const r = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
        return typeof r.file === "string" && r.file ? [{ file: r.file, weight: num(r.weight, 1, 0, Infinity) }] : [];
      })
    : [];
  const file = typeof o.file === "string" && o.file ? o.file : undefined;
  if (!file && variations.length === 0) return `${name}: needs a file or variations`;
  const lo = Array.isArray(o.pitchRange) ? num(o.pitchRange[0], 1, 0.25, 4) : 1;
  const hi = Array.isArray(o.pitchRange) ? num(o.pitchRange[1], 1, 0.25, 4) : 1;
  return {
    name,
    bus: o.bus as EventBus,
    ...(file ? { file } : {}),
    ...(variations.length > 0 ? { variations } : {}),
    volume: num(o.volume, 1, 0, 1),
    positional: o.positional === true,
    maxDistance: num(o.maxDistance, 40, 1, Infinity),
    pitchRange: [Math.min(lo, hi), Math.max(lo, hi)],
    priority: Math.round(num(o.priority, 0, 0, 10)),
  };
}

/** The whole `events.json`; `errors` lists what was dropped. */
export function parseAudioBank(raw: unknown): { bank: SoundBank; errors: string[] } {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const rawBuses = typeof o.buses === "object" && o.buses !== null ? (o.buses as Record<string, unknown>) : {};
  const buses = {} as Record<EventBus, BusSettings>;
  for (const b of EVENT_BUSES) {
    const s = typeof rawBuses[b] === "object" && rawBuses[b] !== null ? (rawBuses[b] as Record<string, unknown>) : {};
    buses[b] = { gain: num(s.gain, DEFAULT_BUS.gain, 0, 1), maxVoices: Math.round(num(s.maxVoices, DEFAULT_BUS.maxVoices, 1, 64)) };
  }
  const errors: string[] = [];
  const events: SoundEvent[] = [];
  const seen = new Set<string>();
  for (const e of Array.isArray(o.events) ? o.events : []) {
    const parsed = parseSoundEvent(e);
    if (typeof parsed === "string") errors.push(parsed);
    else if (seen.has(parsed.name)) errors.push(`${parsed.name}: duplicate event`);
    else {
      seen.add(parsed.name);
      events.push(parsed);
    }
  }
  return { bank: { buses, events }, errors };
}

/** Every file an event can play. */
export const eventFiles = (e: SoundEvent): string[] => (e.variations ? e.variations.map((v) => v.file) : e.file ? [e.file] : []);

/**
 * The file this play uses: a weighted pick among the variations (`rand` is
 * a 0..1 roll, injectable for tests), or the single file. Zero-weight
 * variations never play unless every weight is zero.
 */
export function pickVariation(e: SoundEvent, rand: number): string {
  if (!e.variations) return e.file ?? "";
  const total = e.variations.reduce((s, v) => s + v.weight, 0);
  if (total <= 0) return e.variations[0]!.file;
  let roll = Math.min(Math.max(rand, 0), 0.999999999) * total;
  for (const v of e.variations) {
    if (roll < v.weight) return v.file;
    roll -= v.weight;
  }
  return e.variations[e.variations.length - 1]!.file;
}

/** A point in the world; y is up. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Where the player hears from: the camera's position and the horizontal direction it faces (unit vector in x, z). */
export interface Listener extends Vec3 {
  fx: number;
  fz: number;
}

/** Distance falloff: full volume within a metre, a smooth fall to silence at `maxDistance`. */
export function attenuation(distance: number, maxDistance: number): number {
  if (!(distance < maxDistance)) return 0;
  if (distance <= 1) return 1;
  const t = (distance - 1) / (maxDistance - 1);
  return (1 - t) * (1 - t);
}

/** Stereo position -1 (left) .. 1 (right) of `at` as the listener faces it; sounds on top of you sit in the middle. */
export function stereoPan(listener: Listener, at: Vec3): number {
  const dx = at.x - listener.x;
  const dz = at.z - listener.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) return 0;
  // Seen from above, the right of (fx, fz) is (-fz, fx).
  const right = -dx * listener.fz + dz * listener.fx;
  // Near sounds pan less: inside two metres the pan eases to the centre.
  return Math.max(-1, Math.min(1, (right / d) * Math.min(1, d / 2)));
}

export interface Play {
  file: string;
  /** Final linear gain on the event's bus (event volume x distance falloff). */
  gain: number;
  /** Playback rate. */
  pitch: number;
  pan: number;
}

/** Rolls for `plan`: one random number per decision, so a test can fix them. */
export interface Rolls {
  variation: number;
  pitch: number;
}

/**
 * What one play sounds like, or null when it cannot be heard (a positional
 * event out of range). A positional event with no `at` plays flat (2D).
 */
export function planPlay(e: SoundEvent, listener: Listener | null, at: Vec3 | null, rolls: Rolls): Play | null {
  let gain = e.volume;
  let pan = 0;
  if (e.positional && at && listener) {
    const att = attenuation(Math.hypot(at.x - listener.x, at.y - listener.y, at.z - listener.z), e.maxDistance);
    if (att <= 0) return null;
    gain *= att;
    pan = stereoPan(listener, at);
  }
  const [lo, hi] = e.pitchRange;
  return { file: pickVariation(e, rolls.variation), gain, pitch: lo + (hi - lo) * Math.min(Math.max(rolls.pitch, 0), 1), pan };
}

export interface Voice {
  id: number;
  bus: EventBus;
  priority: number;
  gain: number;
  startedAt: number;
  endsAt: number;
}

/**
 * Voice limits: each bus plays at most `maxVoices` sounds at once. When a
 * bus is full, a new sound steals the weakest voice (lowest priority, then
 * quietest, then oldest) if it outranks it (higher priority, or equal
 * priority and at least as loud); otherwise the new sound is dropped.
 */
export class VoicePool {
  private readonly voices = new Map<number, Voice>();
  private nextId = 1;

  /** Forget the voices that have finished by `now` (seconds). */
  expire(now: number): void {
    for (const [id, v] of this.voices) if (v.endsAt <= now) this.voices.delete(id);
  }

  count(bus: EventBus): number {
    let n = 0;
    for (const v of this.voices.values()) if (v.bus === bus) n++;
    return n;
  }

  /**
   * Ask for a voice. Returns null when refused, else the new voice and the
   * voice to cut off (null when there was room).
   */
  acquire(bus: EventBus, limit: number, priority: number, gain: number, now: number, duration: number): { voice: Voice; stolen: Voice | null } | null {
    this.expire(now);
    let stolen: Voice | null = null;
    if (this.count(bus) >= limit) {
      for (const v of this.voices.values()) {
        if (v.bus !== bus) continue;
        if (!stolen || weaker(v, stolen)) stolen = v;
      }
      if (!stolen || !outranks(priority, gain, stolen)) return null;
      this.voices.delete(stolen.id);
    }
    const voice: Voice = { id: this.nextId++, bus, priority, gain, startedAt: now, endsAt: now + duration };
    this.voices.set(voice.id, voice);
    return { voice, stolen };
  }

  /** A voice that was stopped early. */
  release(id: number): void {
    this.voices.delete(id);
  }
}

const weaker = (a: Voice, b: Voice): boolean =>
  a.priority !== b.priority ? a.priority < b.priority : a.gain !== b.gain ? a.gain < b.gain : a.startedAt < b.startedAt;

const outranks = (priority: number, gain: number, v: Voice): boolean =>
  priority !== v.priority ? priority > v.priority : gain >= v.gain;
