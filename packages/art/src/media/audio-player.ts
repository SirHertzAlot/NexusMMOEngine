/**
 * The Web Audio side of the audio engine: a mixer (a content gain and a
 * player gain per bus, into a master), and `play`, which turns an audio
 * event's recipe into oscillators and noise, places it in the world when
 * the event is spatial, and keeps to the voice limits. The game client's
 * AudioEngine and the editor's Audio panel both use it.
 */
import { AUDIO_BUS_NAMES, VoicePool, type AudioBusName, type AudioDoc, type AudioEvent, type AudioLayer, type Voice } from "./audio.js";

export interface PlayOptions {
  /** World position (spatial events pan and fade with distance from the listener). */
  position?: [number, number, number];
  /** Multiplies the event's gain. */
  gain?: number;
}

export interface Playing {
  readonly event: string;
  stop(fadeSeconds?: number): void;
}

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();
/** Two seconds of white noise per context. */
export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseBuffers.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, buf);
  }
  return buf;
}

export class AudioMixer {
  readonly master: GainNode;
  private readonly content = new Map<AudioBusName, GainNode>();
  private readonly player = new Map<AudioBusName, GainNode>();
  readonly pool: VoicePool;
  private looping = new Map<string, Playing>();

  constructor(readonly ctx: BaseAudioContext, private doc: AudioDoc, out: AudioNode = ctx.destination) {
    this.master = ctx.createGain();
    this.master.connect(out);
    for (const b of AUDIO_BUS_NAMES) {
      const user = ctx.createGain();
      user.connect(this.master);
      const content = ctx.createGain();
      content.gain.value = doc.buses[b].gain;
      content.connect(user);
      this.player.set(b, user);
      this.content.set(b, content);
    }
    this.pool = new VoicePool(doc.maxVoices);
  }

  /** New content (the editor's edit, a reload): limits and bus levels follow; sounding voices finish as they were. */
  setDoc(doc: AudioDoc): void {
    this.doc = doc;
    this.pool.maxVoices = doc.maxVoices;
    for (const b of AUDIO_BUS_NAMES) this.content.get(b)!.gain.setTargetAtTime(doc.buses[b].gain, this.ctx.currentTime, 0.03);
  }

  get events(): AudioDoc["events"] {
    return this.doc.events;
  }

  /** The player's level for a bus (0..1 after the slider curve), or for the master. */
  setPlayerGain(bus: AudioBusName | "master", gain: number, now = false): void {
    const p = bus === "master" ? this.master.gain : this.player.get(bus)!.gain;
    if (now) p.value = gain;
    else p.setTargetAtTime(gain, this.ctx.currentTime, 0.03);
  }

  /** Where the listener is (the camera or the player): position and facing, world space. */
  setListener(position: [number, number, number], forward: [number, number, number]): void {
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = position[0];
      l.positionY.value = position[1];
      l.positionZ.value = position[2];
      l.forwardX.value = forward[0];
      l.forwardY.value = forward[1];
      l.forwardZ.value = forward[2];
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    }
  }

  /** Start an event. Null when it is unknown or in its cooldown (callers check the context is running). */
  play(id: string, opts: PlayOptions = {}): Playing | null {
    const ev = this.doc.events[id];
    if (!ev) return null;
    const now = this.ctx.currentTime;
    if (!this.pool.admit(id, now, ev)) return null;
    const bus = this.content.get(ev.bus)!;
    const out = this.ctx.createGain();
    out.gain.value = (ev.gain ?? 1) * (opts.gain ?? 1);
    let tail: AudioNode = out;
    let panner: PannerNode | null = null;
    if (ev.spatial && opts.position) {
      panner = this.ctx.createPanner();
      panner.panningModel = "equalpower";
      panner.distanceModel = "inverse";
      panner.refDistance = 3;
      panner.maxDistance = 80;
      panner.rolloffFactor = 1.2;
      panner.positionX.value = opts.position[0];
      panner.positionY.value = opts.position[1];
      panner.positionZ.value = opts.position[2];
      out.connect(panner);
      tail = panner;
    }
    tail.connect(bus);
    const stops: Array<() => void> = [];
    let end = 0;
    for (const layer of ev.layers) end = Math.max(end, this.layer(layer, out, now, stops));
    const voice: Voice = {
      event: id,
      startedAt: now,
      endsAt: ev.loop ? Infinity : now + end + 0.05,
      stop: () => {
        out.gain.cancelScheduledValues(this.ctx.currentTime);
        out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
        stops.forEach((s) => s());
      },
    };
    this.pool.add(voice);
    const playing: Playing = {
      event: id,
      stop: (fade = 0.3) => {
        out.gain.cancelScheduledValues(this.ctx.currentTime);
        out.gain.setTargetAtTime(0, this.ctx.currentTime, Math.max(0.01, fade / 4));
        setTimeout(() => stops.forEach((s) => s()), (fade + 0.1) * 1000);
        voice.endsAt = this.ctx.currentTime;
      },
    };
    return playing;
  }

  /**
   * Keep exactly one looping event of a kind going ("music", "weather"):
   * starting another of the same slot fades the old one out. Null id: stop it.
   */
  setLoop(slot: string, id: string | null): void {
    const cur = this.looping.get(slot);
    if (cur?.event === id) return;
    cur?.stop(1.2);
    this.looping.delete(slot);
    if (id) {
      const p = this.play(id);
      if (p) this.looping.set(slot, p);
    }
  }

  stopAll(): void {
    this.pool.stopAll();
    this.looping.clear();
  }

  /** Schedules one layer; returns the seconds it lasts (0 for loops) and pushes its stop function. */
  private layer(l: AudioLayer, out: AudioNode, now: number, stops: Array<() => void>): number {
    const ctx = this.ctx;
    const t = now + (("at" in l ? l.at : undefined) ?? 0);
    switch (l.kind) {
      case "tone": {
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = l.wave;
        osc.frequency.setValueAtTime(l.freq, t);
        if (l.glideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(l.glideTo, t + l.decay);
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(l.peak, t + 0.005);
        env.gain.exponentialRampToValueAtTime(0.0001, t + l.decay);
        osc.connect(env).connect(out);
        osc.start(t);
        osc.stop(t + l.decay + 0.02);
        stops.push(() => safeStop(osc));
        return (l.at ?? 0) + l.decay + 0.02;
      }
      case "noise": {
        const src = ctx.createBufferSource();
        src.buffer = noiseBuffer(ctx);
        const f = ctx.createBiquadFilter();
        f.type = l.filter;
        f.frequency.setValueAtTime(l.freq, t);
        if (l.sweepTo !== undefined) f.frequency.exponentialRampToValueAtTime(l.sweepTo, t + l.decay);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(l.peak, t + 0.01);
        env.gain.exponentialRampToValueAtTime(0.0001, t + l.decay);
        src.connect(f).connect(env).connect(out);
        src.start(t);
        src.stop(t + l.decay + 0.02);
        stops.push(() => safeStop(src));
        return (l.at ?? 0) + l.decay + 0.02;
      }
      case "bed": {
        const src = ctx.createBufferSource();
        src.buffer = noiseBuffer(ctx);
        src.loop = true;
        const f = ctx.createBiquadFilter();
        f.type = l.filter;
        f.frequency.value = l.freq;
        f.Q.value = l.q ?? 0.6;
        const level = ctx.createGain();
        level.gain.value = l.level;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = l.lfoHz;
        const depth = ctx.createGain();
        depth.gain.value = l.lfoDepth;
        lfo.connect(depth).connect(level.gain);
        src.connect(f).connect(level).connect(out);
        src.start(t);
        lfo.start(t);
        stops.push(() => {
          safeStop(src);
          safeStop(lfo);
        });
        return 0;
      }
      case "drone": {
        const level = ctx.createGain();
        level.gain.value = l.level / l.freqs.length;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = l.lfoHz;
        const depth = ctx.createGain();
        depth.gain.value = (l.level / l.freqs.length) * l.lfoDepth;
        lfo.connect(depth).connect(level.gain);
        level.connect(out);
        const oscs = l.freqs.map((f, i) => {
          const o = ctx.createOscillator();
          o.type = l.wave;
          o.frequency.value = f;
          o.detune.value = (i % 2 ? 1 : -1) * 4;
          o.connect(level);
          o.start(t);
          return o;
        });
        lfo.start(t);
        stops.push(() => {
          oscs.forEach(safeStop);
          safeStop(lfo);
        });
        return 0;
      }
    }
  }
}

function safeStop(n: AudioScheduledSourceNode, when = 0): void {
  try {
    n.stop(when);
  } catch {
    // already stopped
  }
}

export type { AudioEvent };
