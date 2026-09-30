/**
 * PerfSampler — the numbers behind the HUD's performance panel, one
 * sample a second with the last minute kept for its graphs.
 *
 * Per frame it takes the frame time and what the renderer drew (draw
 * calls and triangles, summed over every pass: the scene, shadows, the
 * screen effects); once a second it folds them into a sample with the
 * gauges read then: what the GPU holds (geometries, textures, shader
 * programs), what the props cost against full detail and how many are at
 * each level of detail, the entities and terrain chunks, the network
 * rates from the mirror client's byte counters, and the JS heap where the
 * browser reports it.
 */

/** Samples kept: a minute at one a second. */
export const PERF_HISTORY = 60;

/** What is read once a second (everything but the frame counters and the rates). */
export interface PerfGauges {
  geometries: number;
  textures: number;
  programs: number;
  props: number;
  propDrawCalls: number;
  propTriangles: number;
  /** The triangles the props would cost at full detail. */
  propFullTriangles: number;
  /** Props drawn at each level of detail, full detail first. */
  propsPerLevel: number[];
  entities: number;
  chunks: number;
  /** JS heap in use, bytes (null: the browser doesn't say). */
  heapBytes: number | null;
}

export interface PerfSample extends PerfGauges {
  /** performance.now() of the sample. */
  at: number;
  fps: number;
  /** Mean and worst frame time over the second, ms. */
  frameMs: number;
  frameMaxMs: number;
  /** Mean draw calls and triangles per frame. */
  drawCalls: number;
  triangles: number;
  /** Network rates, bytes a second. */
  inBytesPerSec: number;
  outBytesPerSec: number;
}

export interface Traffic {
  bytesIn: number;
  bytesOut: number;
}

export class PerfSampler {
  private readonly samples: PerfSample[] = [];
  private frames = 0;
  private frameMsSum = 0;
  private frameMaxMs = 0;
  private calls = 0;
  private triangles = 0;
  private since: number;
  private traffic: Traffic | null = null;

  constructor(
    now: number,
    private readonly every = 1000,
  ) {
    this.since = now;
  }

  /** One frame: its time and what the renderer drew for it. */
  frame(ms: number, drawCalls: number, triangles: number): void {
    this.frames++;
    this.frameMsSum += ms;
    this.frameMaxMs = Math.max(this.frameMaxMs, ms);
    this.calls += drawCalls;
    this.triangles += triangles;
  }

  /** A second has passed since the last sample. */
  due(now: number): boolean {
    return now - this.since >= this.every;
  }

  /** Close the second: a sample from the frames since the last one, the gauges, and the traffic counters. */
  sample(now: number, gauges: PerfGauges, traffic: Traffic): PerfSample {
    const seconds = Math.max(1e-3, (now - this.since) / 1000);
    const n = Math.max(1, this.frames);
    const prev = this.traffic ?? traffic;
    const s: PerfSample = {
      ...gauges,
      propsPerLevel: [...gauges.propsPerLevel],
      at: now,
      fps: this.frames / seconds,
      frameMs: this.frameMsSum / n,
      frameMaxMs: this.frameMaxMs,
      drawCalls: this.calls / n,
      triangles: this.triangles / n,
      inBytesPerSec: Math.max(0, traffic.bytesIn - prev.bytesIn) / seconds,
      outBytesPerSec: Math.max(0, traffic.bytesOut - prev.bytesOut) / seconds,
    };
    this.traffic = { bytesIn: traffic.bytesIn, bytesOut: traffic.bytesOut };
    this.samples.push(s);
    if (this.samples.length > PERF_HISTORY) this.samples.shift();
    this.since = now;
    this.frames = 0;
    this.frameMsSum = 0;
    this.frameMaxMs = 0;
    this.calls = 0;
    this.triangles = 0;
    return s;
  }

  /** The kept samples, oldest first (a copy). */
  history(): PerfSample[] {
    return [...this.samples];
  }
}

/** 1234 -> "1.2k", 3_400_000 -> "3.4M". */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${trim(n / 1e6)}M`;
  if (a >= 1e3) return `${trim(n / 1e3)}k`;
  return `${Math.round(n)}`;
}

/** Bytes (or bytes a second) in B, kB, MB. */
export function bytes(n: number): string {
  if (n >= 1024 * 1024) return `${trim(n / (1024 * 1024))} MB`;
  if (n >= 1024) return `${trim(n / 1024)} kB`;
  return `${Math.round(n)} B`;
}

function trim(x: number): string {
  return x >= 100 ? x.toFixed(0) : x.toFixed(1);
}
