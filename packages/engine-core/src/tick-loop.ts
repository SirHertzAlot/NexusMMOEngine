/**
 * Fixed-timestep simulation loop (slice 1.2, architecture brief §7).
 *
 * The sim advances in fixed steps of STEP_MS (30 Hz). The accumulator
 * converts variable real-time frame deltas into a whole number of steps,
 * so the simulation is deterministic for a given tick count regardless
 * of wall-clock jitter.
 *
 * Spiral-of-death guard: a frame delta is clamped to MAX_FRAME_DELTA_MS
 * (e.g. debugger pause, tab switch), and at most MAX_STEPS_PER_FRAME
 * catch-up steps run per frame. Any backlog beyond that is dropped and
 * counted (spiralEvents / droppedMs) instead of freezing the process in
 * an unbounded catch-up loop.
 *
 * Network send is decoupled from the sim step (slice 1.3 owns that); the
 * loop only guarantees *when* ticks happen, never *what* they contain.
 */

export const STEP_MS = 1000 / 30; // 33.333... ms per tick
export const MAX_STEPS_PER_FRAME = 5; // spiral-of-death guard (PLAN §1.2)
export const MAX_FRAME_DELTA_MS = 250; // clamp pathological frame gaps

/**
 * Epsilon for the step-boundary comparison (1 ns). Floating-point
 * accumulation of exact-multiple timestamps (tests, deterministic
 * replays) can leave the accumulator ~1 ulp short of a whole step and
 * permanently lose a tick; the epsilon absorbs that dust. It cannot
 * create extra ticks: over N exact steps the count stays exactly N.
 */
const STEP_EPS_MS = 1e-6;

export interface TickLoopStats {
  /** Total ticks executed. */
  ticks: number;
  /** Frames where the catch-up cap was hit and backlog was dropped. */
  spiralEvents: number;
  /** Total sim-time (ms) dropped by the spiral guard. */
  droppedMs: number;
}

export class TickLoop {
  private accMs = 0;
  private lastMs: number | null = null;
  private tickCount = 0;
  private spirals = 0;
  private dropped = 0;

  constructor(
    private readonly onTick: (tick: number) => void,
    private readonly stepMs: number = STEP_MS,
    private readonly maxStepsPerFrame: number = MAX_STEPS_PER_FRAME,
    private readonly maxFrameDeltaMs: number = MAX_FRAME_DELTA_MS,
  ) {
    if (stepMs <= 0) throw new RangeError("stepMs must be positive");
    if (maxStepsPerFrame < 1)
      throw new RangeError("maxStepsPerFrame must be >= 1");
  }

  /**
   * Advance the loop to `nowMs`. Returns the number of ticks executed.
   * The first call only arms the clock (no tick runs on it).
   */
  frame(nowMs: number): number {
    if (this.lastMs === null) {
      this.lastMs = nowMs;
      return 0;
    }
    let delta = nowMs - this.lastMs;
    this.lastMs = nowMs;
    if (delta < 0) delta = 0; // clock stepped backwards; ignore
    if (delta > this.maxFrameDeltaMs) delta = this.maxFrameDeltaMs;

    this.accMs += delta;
    let steps = 0;
    while (this.accMs + STEP_EPS_MS >= this.stepMs && steps < this.maxStepsPerFrame) {
      this.onTick(this.tickCount);
      this.tickCount += 1;
      this.accMs -= this.stepMs;
      steps += 1;
    }
    if (this.accMs + STEP_EPS_MS >= this.stepMs) {
      // Spiral guard: drop the backlog rather than spiral forever.
      this.spirals += 1;
      this.dropped += this.accMs;
      this.accMs = 0;
    }
    return steps;
  }

  stats(): TickLoopStats {
    return {
      ticks: this.tickCount,
      spiralEvents: this.spirals,
      droppedMs: this.dropped,
    };
  }
}
