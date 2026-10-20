/**
 * Synthesis building blocks (U4 audio): tones and filtered noise from
 * oscillators and a noise buffer, the ambient wind bed, and nothing else.
 * The sounds themselves are audio events (events.json), voiced by
 * placeholders.ts until recordings replace them.
 */

/** Plays a tone: `freq` Hz, `type`, attack-decay envelope peaking at `peak`, starting `at` seconds from now. */
export function tone(ctx: BaseAudioContext, out: AudioNode, freq: number, type: OscillatorType, peak: number, decay: number, at = 0, glideTo?: number): void {
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
export function noise(ctx: BaseAudioContext, out: AudioNode, filter: BiquadFilterType, freq: number, peak: number, decay: number, sweepTo?: number): void {
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

/**
 * Rain (WX1): looping noise through a band-pass whose level drifts with a
 * slow LFO, like wind but brighter and steadier. The caller modulates the
 * level gain with the weather field's rain intensity. Returns a stop function.
 */
export function startRain(ctx: BaseAudioContext, out: AudioNode): () => void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 1800;
  band.Q.value = 0.4;
  const level = ctx.createGain();
  level.gain.value = 0;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.13;
  const depth = ctx.createGain();
  depth.gain.value = 0.04;
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
