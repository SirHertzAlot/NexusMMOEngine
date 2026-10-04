/**
 * Synthesized sound cues (U4 audio, first slice). There are no recorded
 * sounds yet, so each cue is built from oscillators and noise on the spot;
 * a cue keeps its name and bus when samples replace it.
 */

import type { AudioBus } from "./volumes.js";

export type Cue = "whisper" | "notice" | "click" | "hit" | "block" | "dodge";

export const CUE_BUS: Record<Cue, AudioBus> = {
  whisper: "interface",
  notice: "interface",
  click: "interface",
  hit: "effects",
  block: "effects",
  dodge: "effects",
};

/** Plays a tone: `freq` Hz, `type`, attack-decay envelope peaking at `peak`, starting `at` seconds from now. */
function tone(ctx: BaseAudioContext, out: AudioNode, freq: number, type: OscillatorType, peak: number, decay: number, at = 0, glideTo?: number): void {
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(glideTo, t + decay);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + 0.005);
  env.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  osc.connect(env).connect(out);
  osc.start(t);
  osc.stop(t + decay + 0.02);
}

/** A second of white noise, made once per context. */
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();
export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseBuffers.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, buf);
  }
  return buf;
}

/** Filtered noise burst; `sweepTo` glides the filter for a whoosh. */
function noise(ctx: BaseAudioContext, out: AudioNode, filter: BiquadFilterType, freq: number, peak: number, decay: number, sweepTo?: number): void {
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.frequency.setValueAtTime(freq, t);
  if (sweepTo !== undefined) f.frequency.exponentialRampToValueAtTime(sweepTo, t + decay);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + 0.01);
  env.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  src.connect(f).connect(env).connect(out);
  src.start(t);
  src.stop(t + decay + 0.02);
}

/** Schedules `cue` into `out` (its bus). */
export function playCue(ctx: BaseAudioContext, out: AudioNode, cue: Cue): void {
  switch (cue) {
    case "whisper": // a soft rising two-note chime
      tone(ctx, out, 880, "sine", 0.25, 0.35);
      tone(ctx, out, 1318.5, "sine", 0.22, 0.5, 0.12);
      break;
    case "notice":
      tone(ctx, out, 660, "triangle", 0.2, 0.25);
      break;
    case "click":
      tone(ctx, out, 1800, "square", 0.08, 0.03);
      break;
    case "hit": // a dull thump with grit on top
      tone(ctx, out, 140, "sine", 0.7, 0.22, 0, 55);
      noise(ctx, out, "lowpass", 900, 0.45, 0.14);
      break;
    case "block": // metal on metal
      tone(ctx, out, 1240, "triangle", 0.22, 0.4);
      tone(ctx, out, 1710, "triangle", 0.15, 0.3);
      noise(ctx, out, "highpass", 3000, 0.2, 0.06);
      break;
    case "dodge": // air moving past
      noise(ctx, out, "bandpass", 500, 1.2, 0.25, 2400);
      break;
  }
}

/**
 * Wind: looping noise through a low band-pass whose level drifts with a
 * slow LFO, so it breathes instead of hissing. Returns a stop function.
 */
export function startWind(ctx: BaseAudioContext, out: AudioNode): () => void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 420;
  band.Q.value = 0.6;
  const level = ctx.createGain();
  level.gain.value = 0.18;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.08;
  const depth = ctx.createGain();
  depth.gain.value = 0.1;
  lfo.connect(depth).connect(level.gain);
  src.connect(band).connect(level).connect(out);
  src.start();
  lfo.start();
  return () => {
    src.stop();
    lfo.stop();
    level.disconnect();
  };
}
