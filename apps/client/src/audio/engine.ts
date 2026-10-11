/**
 * AudioEngine (U4 audio): the client's Web Audio graph. Cues play into one
 * bus each (combat, interface, ambience), each bus into the master, so the
 * settings sliders map one-to-one onto gain nodes.
 *
 * Browsers only let audio start after a user gesture, so the context is
 * created on the first `unlock()` (a click or key press); cues before that
 * are dropped. Audio pauses while the tab is hidden.
 */

import { startWind } from "./cues.js";
import { playPlaceholder } from "./placeholders.js";
import { type EventBus, type Listener, planPlay, type SoundBank, type Vec3, VoicePool, DEFAULT_BUS, type BusSettings } from "./sound-logic.js";
import { AUDIO_BUSES, type AudioBus, masterGain, sliderGain, type Volumes } from "./volumes.js";

/** The settings slider each event bus plays through ("master" plays straight into the master). */
const SLIDER_OF: Record<Exclude<EventBus, "master">, AudioBus> = { combat: "effects", interface: "interface", ambience: "ambience" };

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly buses = new Map<AudioBus, GainNode>();
  private stopWind: (() => void) | null = null;
  private ambience = false;
  // Audio events (EA24): the bank from content/audio/events.json, the camera, and who is playing.
  private bank: SoundBank | null = null;
  private listener: Listener | null = null;
  private readonly pool = new VoicePool();
  private readonly voiceGains = new Map<number, GainNode>();

  constructor(private volumes: Volumes) {}

  /** Create (or resume) the context; call from a user gesture. Safe to call repeatedly. */
  unlock(): Promise<void> {
    if (typeof AudioContext === "undefined") return Promise.resolve();
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      for (const b of AUDIO_BUSES) {
        const g = ctx.createGain();
        g.connect(this.master);
        this.buses.set(b, g);
      }
      this.apply(true);
      if (this.ambience) this.setAmbience(true);
    }
    if (this.ctx.state === "suspended" && !document.hidden) return this.ctx.resume();
    return Promise.resolve();
  }

  /** Whether sound can play yet. */
  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  setVolumes(v: Volumes): void {
    this.volumes = v;
    this.apply(false);
  }

  /** The audio events and mixer settings in force; takes effect on the next sound. */
  setBank(bank: SoundBank): void {
    this.bank = bank;
    this.apply(false);
  }

  /** Where the player hears from (the camera); call as it moves. */
  setListener(listener: Listener | null): void {
    this.listener = listener;
  }

  /** Sounds currently playing on an event bus. */
  voices(bus: EventBus): number {
    if (!this.ctx) return 0;
    this.pool.expire(this.ctx.currentTime);
    return this.pool.count(bus);
  }

  /**
   * Fires an audio event by name. `at` places a positional event in the
   * world. Returns whether anything started: false for an unknown event,
   * a locked or silent context, a sound out of range or a full bus.
   * `file` plays that clip instead of the picked variation (the editor's
   * per-clip audition).
   */
  playEvent(name: string, at?: Vec3 | null, file?: string): boolean {
    const e = this.bank?.events.find((x) => x.name === name);
    if (!e || !this.bank || !this.ctx || this.ctx.state !== "running") return false;
    const out = e.bus === "master" ? this.master : this.buses.get(SLIDER_OF[e.bus]);
    if (!out) return false;
    const plan = planPlay(e, this.listener, at ?? null, { variation: Math.random(), pitch: Math.random() });
    if (!plan) return false;
    const ctx = this.ctx;
    const granted = this.pool.acquire(e.bus, this.bank.buses[e.bus].maxVoices, e.priority, plan.gain, ctx.currentTime, 2);
    if (!granted) return false;
    if (granted.stolen) this.cut(granted.stolen.id);
    const voice = ctx.createGain();
    voice.gain.value = plan.gain;
    const pan = ctx.createStereoPanner();
    pan.pan.value = plan.pan;
    voice.connect(pan).connect(out);
    const length = playPlaceholder(ctx, voice, file ?? plan.file, plan.pitch);
    granted.voice.endsAt = ctx.currentTime + length;
    this.voiceGains.set(granted.voice.id, voice);
    window.setTimeout(() => {
      this.voiceGains.delete(granted.voice.id);
      voice.disconnect();
    }, (length + 0.1) * 1000);
    return true;
  }

  /** A stolen voice fades out fast instead of clicking off. */
  private cut(id: number): void {
    const g = this.voiceGains.get(id);
    if (g && this.ctx) g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
    this.voiceGains.delete(id);
  }

  /** The world's ambient bed: on while in the world, off on the login screens. */
  setAmbience(on: boolean): void {
    this.ambience = on;
    const bus = this.buses.get("ambience");
    if (on && !this.stopWind && this.ctx && bus) this.stopWind = startWind(this.ctx, bus);
    if (!on && this.stopWind) {
      this.stopWind();
      this.stopWind = null;
    }
  }

  /** Pause with the tab. */
  setHidden(hidden: boolean): void {
    if (!this.ctx) return;
    void (hidden ? this.ctx.suspend() : this.ctx.resume());
  }

  private apply(now: boolean): void {
    if (!this.ctx || !this.master) return;
    // A short glide so dragging a slider doesn't click.
    const set = (p: AudioParam, v: number): void => {
      if (now) p.value = v;
      else p.setTargetAtTime(v, this.ctx!.currentTime, 0.03);
    };
    // The sliders are the player's level; the bank's bus gain is the designer's mix on top.
    const mix = (bus: EventBus): BusSettings => this.bank?.buses[bus] ?? DEFAULT_BUS;
    set(this.master.gain, masterGain(this.volumes) * mix("master").gain);
    for (const e of Object.keys(SLIDER_OF) as (keyof typeof SLIDER_OF)[]) {
      const b = SLIDER_OF[e];
      set(this.buses.get(b)!.gain, sliderGain(this.volumes[b]) * mix(e).gain);
    }
  }
}
