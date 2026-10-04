/**
 * AudioEngine (U4 audio): the client's Web Audio graph. Cues play into one
 * bus each (combat, interface, ambience), each bus into the master, so the
 * settings sliders map one-to-one onto gain nodes.
 *
 * Browsers only let audio start after a user gesture, so the context is
 * created on the first `unlock()` (a click or key press); cues before that
 * are dropped. Audio pauses while the tab is hidden.
 */

import { type Cue, CUE_BUS, playCue, startWind } from "./cues.js";
import { AUDIO_BUSES, type AudioBus, masterGain, sliderGain, type Volumes } from "./volumes.js";

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly buses = new Map<AudioBus, GainNode>();
  private stopWind: (() => void) | null = null;
  private ambience = false;

  constructor(private volumes: Volumes) {}

  /** Create (or resume) the context; call from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (typeof AudioContext === "undefined") return;
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
    if (this.ctx.state === "suspended" && !document.hidden) void this.ctx.resume();
  }

  /** Whether sound can play yet. */
  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  setVolumes(v: Volumes): void {
    this.volumes = v;
    this.apply(false);
  }

  play(cue: Cue): void {
    const bus = this.buses.get(CUE_BUS[cue]);
    if (!this.ctx || !bus || this.ctx.state !== "running") return;
    playCue(this.ctx, bus, cue);
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
    set(this.master.gain, masterGain(this.volumes));
    for (const b of AUDIO_BUSES) set(this.buses.get(b)!.gain, sliderGain(this.volumes[b]));
  }
}
