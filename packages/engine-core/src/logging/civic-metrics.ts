/**
 * CivicTelemetryMetrics — Track C7a: Zero-Allocation SAB Telemetry Gauges
 *
 * Adheres strictly to AGENTS.md §6:
 * - Single 64-byte SharedArrayBuffer (one L1/L2 cache line) shared across threads.
 * - Fixed Int32Array (atomic integer gauges) + Float64Array (8-byte aligned floats).
 * - Inlined constant word offsets for direct V8 register-indirect load/store.
 * - `recordSweep(...)` executes in nanoseconds with 0 closures, 0 arrays,
 *   0 object allocations, and 0 per-record clock syscalls, strictly on the 1 Hz sweep.
 */

export const CIVIC_METRICS_MAGIC = 0x43495631; // "CIV1"
export const CIVIC_METRICS_BYTES = 64;

// Int32Array word offsets (bytes 0..31, 8 x 4-byte words)
const W_MAGIC = 0;
const W_ACTIVE_VEINS = 1;
const W_OPEN_CONTRACTS = 2;
const W_BRIDGE_STAGE = 3;
const W_MATURE_FOUNDRIES = 4;
const W_SWEEP_COUNT = 5;

// Float64Array slot offsets starting at byteOffset 32 (bytes 32..63, 4 x 8-byte slots)
const F64_BYTE_OFFSET = 32;
const F64_SLOTS = 4;
const F_BRIDGE_WEAR = 0;
const F_LAST_SWEEP_MICROS = 1;

const I32_MAX = 0x7fffffff;

export interface CivicTelemetrySnapshot {
  activeVeins: number;
  openContracts: number;
  bridgeStage: number;
  bridgeWear: number;
  matureFoundries: number;
  lastSweepMicros: number;
  sweepCount: number;
}

export class CivicTelemetryMetrics {
  public readonly sab: SharedArrayBuffer;
  private readonly i32: Int32Array;
  private readonly f64: Float64Array;

  constructor(existing?: SharedArrayBuffer) {
    if (existing !== undefined) {
      if (existing.byteLength < CIVIC_METRICS_BYTES) {
        throw new RangeError(
          `CivicTelemetryMetrics: SharedArrayBuffer byteLength ${existing.byteLength} < ${CIVIC_METRICS_BYTES}`,
        );
      }
      this.sab = existing;
      this.i32 = new Int32Array(this.sab, 0, 8);
      this.f64 = new Float64Array(this.sab, F64_BYTE_OFFSET, F64_SLOTS);
      if (Atomics.load(this.i32, W_MAGIC) !== CIVIC_METRICS_MAGIC) {
        throw new Error("CivicTelemetryMetrics: invalid magic header in SharedArrayBuffer");
      }
    } else {
      this.sab = new SharedArrayBuffer(CIVIC_METRICS_BYTES);
      this.i32 = new Int32Array(this.sab, 0, 8);
      this.f64 = new Float64Array(this.sab, F64_BYTE_OFFSET, F64_SLOTS);
      Atomics.store(this.i32, W_MAGIC, CIVIC_METRICS_MAGIC);
    }
  }

  /**
   * Record one 1 Hz civic sweep snapshot with zero heap allocations, zero closures,
   * zero arrays, and zero clock syscalls.
   */
  public recordSweep(
    activeVeins: number,
    openContracts: number,
    bridgeStage: number,
    bridgeWear: number,
    matureFoundries: number,
    lastSweepMicros: number = 0,
  ): void {
    const veins =
      Number.isFinite(activeVeins) && activeVeins > 0
        ? activeVeins > I32_MAX
          ? I32_MAX
          : activeVeins | 0
        : 0;
    const contracts =
      Number.isFinite(openContracts) && openContracts > 0
        ? openContracts > I32_MAX
          ? I32_MAX
          : openContracts | 0
        : 0;
    const stage =
      Number.isFinite(bridgeStage) && bridgeStage > 0
        ? bridgeStage > I32_MAX
          ? I32_MAX
          : bridgeStage | 0
        : 0;
    const foundries =
      Number.isFinite(matureFoundries) && matureFoundries > 0
        ? matureFoundries > I32_MAX
          ? I32_MAX
          : matureFoundries | 0
        : 0;
    const wear = Number.isFinite(bridgeWear) && bridgeWear > 0 ? bridgeWear : 0;
    const micros =
      Number.isFinite(lastSweepMicros) && lastSweepMicros > 0 ? lastSweepMicros : 0;

    Atomics.store(this.i32, W_ACTIVE_VEINS, veins);
    Atomics.store(this.i32, W_OPEN_CONTRACTS, contracts);
    Atomics.store(this.i32, W_BRIDGE_STAGE, stage);
    Atomics.store(this.i32, W_MATURE_FOUNDRIES, foundries);
    this.f64[F_BRIDGE_WEAR] = wear;
    this.f64[F_LAST_SWEEP_MICROS] = micros;
    Atomics.add(this.i32, W_SWEEP_COUNT, 1);
  }

  public get activeVeins(): number {
    return Atomics.load(this.i32, W_ACTIVE_VEINS);
  }

  public get openContracts(): number {
    return Atomics.load(this.i32, W_OPEN_CONTRACTS);
  }

  public get bridgeStage(): number {
    return Atomics.load(this.i32, W_BRIDGE_STAGE);
  }

  public get bridgeWear(): number {
    return this.f64[F_BRIDGE_WEAR] ?? 0;
  }

  public get matureFoundries(): number {
    return Atomics.load(this.i32, W_MATURE_FOUNDRIES);
  }

  public get lastSweepMicros(): number {
    return this.f64[F_LAST_SWEEP_MICROS] ?? 0;
  }

  public get sweepCount(): number {
    return Atomics.load(this.i32, W_SWEEP_COUNT);
  }

  /**
   * Read all gauges atomically into `out` (zero-allocation when caller supplies a
   * preallocated object) or return a fresh snapshot object.
   */
  public snapshot(out?: CivicTelemetrySnapshot): CivicTelemetrySnapshot {
    const activeVeins = Atomics.load(this.i32, W_ACTIVE_VEINS);
    const openContracts = Atomics.load(this.i32, W_OPEN_CONTRACTS);
    const bridgeStage = Atomics.load(this.i32, W_BRIDGE_STAGE);
    const matureFoundries = Atomics.load(this.i32, W_MATURE_FOUNDRIES);
    const sweepCount = Atomics.load(this.i32, W_SWEEP_COUNT);
    const bridgeWear = this.f64[F_BRIDGE_WEAR] ?? 0;
    const lastSweepMicros = this.f64[F_LAST_SWEEP_MICROS] ?? 0;
    if (out !== undefined) {
      out.activeVeins = activeVeins;
      out.openContracts = openContracts;
      out.bridgeStage = bridgeStage;
      out.bridgeWear = bridgeWear;
      out.matureFoundries = matureFoundries;
      out.lastSweepMicros = lastSweepMicros;
      out.sweepCount = sweepCount;
      return out;
    }
    return {
      activeVeins,
      openContracts,
      bridgeStage,
      bridgeWear,
      matureFoundries,
      lastSweepMicros,
      sweepCount,
    };
  }

  /** Prometheus text exposition 0.0.4, mergeable with core & log metrics. */
  public renderPrometheusMetrics(): string {
    const activeVeins = Atomics.load(this.i32, W_ACTIVE_VEINS);
    const openContracts = Atomics.load(this.i32, W_OPEN_CONTRACTS);
    const bridgeStage = Atomics.load(this.i32, W_BRIDGE_STAGE);
    const matureFoundries = Atomics.load(this.i32, W_MATURE_FOUNDRIES);
    const sweepCount = Atomics.load(this.i32, W_SWEEP_COUNT);
    const bridgeWear = this.f64[F_BRIDGE_WEAR] ?? 0;
    const lastSweepMicros = this.f64[F_LAST_SWEEP_MICROS] ?? 0;

    return (
      [
        "# HELP mmo_civic_active_veins Active civic mineral veins with remaining stock.",
        "# TYPE mmo_civic_active_veins gauge",
        `mmo_civic_active_veins ${activeVeins}`,
        "# HELP mmo_civic_open_contracts Open frontier civic logistics contracts.",
        "# TYPE mmo_civic_open_contracts gauge",
        `mmo_civic_open_contracts ${openContracts}`,
        "# HELP mmo_civic_bridge_stage Current construction stage of the primary civic bridge.",
        "# TYPE mmo_civic_bridge_stage gauge",
        `mmo_civic_bridge_stage ${bridgeStage}`,
        "# HELP mmo_civic_bridge_wear Accumulated structural wear on the primary civic bridge.",
        "# TYPE mmo_civic_bridge_wear gauge",
        `mmo_civic_bridge_wear ${bridgeWear}`,
        "# HELP mmo_civic_mature_foundries Settlement foundries at or above maturity threshold.",
        "# TYPE mmo_civic_mature_foundries gauge",
        `mmo_civic_mature_foundries ${matureFoundries}`,
        "# HELP mmo_civic_sweep_duration_micros Duration of the most recent 1 Hz civic sweep in microseconds.",
        "# TYPE mmo_civic_sweep_duration_micros gauge",
        `mmo_civic_sweep_duration_micros ${lastSweepMicros}`,
        "# HELP mmo_civic_sweeps_total Total 1 Hz civic telemetry sweeps recorded.",
        "# TYPE mmo_civic_sweeps_total counter",
        `mmo_civic_sweeps_total ${sweepCount}`,
      ].join("\n") + "\n"
    );
  }
}
