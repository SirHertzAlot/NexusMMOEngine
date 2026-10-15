/**
 * Relief shaping for mountain ranges: what makes a crest a crest.
 *
 *  - crestProfile: the cross-section of a range, from a rounded dome
 *    (sharpness 0, the original quartic) toward a pointed ridge line;
 *  - ridgedMultifractal: octaves of ridged noise (Musgrave), each octave
 *    weighted by the one before so detail piles up on the crests and the
 *    flanks stay smooth.
 */

/** Cross-range height share at r (0 on the axis, 1 at the foot), 0..1. */
export function crestProfile(r: number, sharpness: number): number {
  const dome = (1 - r * r) * (1 - r * r);
  if (sharpness === 0) return dome;
  const ridge = Math.pow(1 - r, 1.6);
  return dome + sharpness * (ridge - dome);
}

/**
 * Combine noise octaves (each -1..1, coarse to fine) into 0..1 ridged
 * multifractal; `gain` is how much a strong crest in one octave passes to
 * the next.
 */
export function ridgedMultifractal(octaves: Float32Array[], gain: number): Float32Array {
  const n = octaves[0].length;
  const out = new Float32Array(n);
  const weight = new Float32Array(n).fill(1);
  let amp = 1;
  let total = 0;
  for (const f of octaves) {
    for (let i = 0; i < n; i++) {
      const s = 1 - Math.abs(f[i]);
      const signal = s * s * weight[i];
      out[i] += amp * signal;
      weight[i] = Math.min(1, signal * gain * 2);
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < n; i++) out[i] = Math.min(1, Math.max(0, out[i] / total));
  return out;
}
