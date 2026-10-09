/**
 * AudioEngine (U4 audio): the client's Web Audio engine. It owns the
 * AudioContext and an AudioMixer (@mmo-engine/art): a bus each for combat
 * effects, interface, ambience and music, into a master, with voice limits
 * and 3D panning. What plays is content/audio/events.json (generated tones
 * until recorded samples replace them), and what triggers it is that
 * file's hooks: music by scene, an ambient bed by weather, footsteps by
 * surface, combat sounds by outcome and by move.
 *
 * The settings sliders (Volumes) set the player's level per bus; the
 * document's bus gains are the mixer defaults under them.
 *
 * Browsers only let audio start after a user gesture, so the context is
 * created on the first `unlock()` (a click or key press); sounds before
 * that are dropped, and the music and bed that should be playing start
 * then. Audio pauses while the tab is hidden.
 */

import { AUDIO_BUS_NAMES, AudioMixer, type AudioDoc, type PlayOptions } from "@mmo-engine/art/browser";
import { masterGain, sliderGain, type Volumes } from "./volumes.js";

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private mixer: AudioMixer | null = null;
  private scene: string | null = null;
  private weather: string | null = "clear";
  private inWorld = false;

  constructor(private volumes: Volumes, private doc: AudioDoc | null = null) {}

  /** Create (or resume) the context; call from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (typeof AudioContext === "undefined" || !this.doc) return;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.mixer = new AudioMixer(this.ctx, this.doc);
      this.apply(true);
    }
    if (this.ctx.state === "suspended" && !document.hidden) void this.ctx.resume();
    this.refreshLoops();
  }

  /** Whether sound can play yet. */
  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  /** The audio content changed (a reload in dev): limits, bus levels and recipes follow. */
  setContent(doc: AudioDoc): void {
    this.doc = doc;
    this.mixer?.setDoc(doc);
    this.refreshLoops();
  }

  setVolumes(v: Volumes): void {
    this.volumes = v;
    this.apply(false);
  }

  /** Play an audio event (a cue name, a hook's event, a move's sound). Dropped before the first gesture. */
  play(id: string, opts?: PlayOptions): void {
    if (this.ready) this.mixer?.play(id, opts);
  }

  /** Where the listener is: the camera's position and facing, world space. */
  setListener(position: [number, number, number], forward: [number, number, number]): void {
    if (this.ready) this.mixer?.setListener(position, forward);
  }

  /** The flow's scene changed: the music its hook names (content/audio hooks.scene) plays. */
  setScene(scene: string | null): void {
    this.scene = scene;
    this.refreshLoops();
  }

  /** The weather where the player is (a kind, or "clear"): its ambient bed plays while in the world. */
  setWeather(kind: string | null): void {
    this.weather = kind ?? "clear";
    this.refreshLoops();
  }

  /** The world's ambient bed: on while in the world, off on the login screens. */
  setAmbience(on: boolean): void {
    this.inWorld = on;
    this.refreshLoops();
  }

  /** Pause with the tab. */
  setHidden(hidden: boolean): void {
    if (!this.ctx) return;
    void (hidden ? this.ctx.suspend() : this.ctx.resume());
  }

  /** The document in force (hooks for footsteps and combat). */
  get content(): AudioDoc | null {
    return this.doc;
  }

  private refreshLoops(): void {
    if (!this.mixer || !this.doc || !this.ready) return;
    const hooks = this.doc.hooks;
    this.mixer.setLoop("music", this.scene ? (hooks.scene[this.scene] ?? null) : null);
    this.mixer.setLoop("weather", this.inWorld ? (hooks.weather[this.weather ?? "clear"] ?? null) : null);
  }

  private apply(now: boolean): void {
    if (!this.mixer) return;
    this.mixer.setPlayerGain("master", masterGain(this.volumes), now);
    for (const b of AUDIO_BUS_NAMES) this.mixer.setPlayerGain(b, sliderGain(this.volumes[b]), now);
  }
}
