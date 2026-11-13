/**
 * Dust puffs (DE1): the small pooled simulation behind a prop's hit effect. Fixed capacity, a ring: when full,
 * the oldest puff is overwritten, so a flood of hits costs the same as a few. Pure arrays; the layer draws them.
 */

export const DUST_CAPACITY = 128;
export const DUST_LIFE_S = 0.9;

export class DustSim {
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  /** Seconds lived; a puff at or past its life is dead. */
  readonly age: Float32Array;
  private next = 0;
  private rng: number;

  constructor(readonly capacity = DUST_CAPACITY, seed = 1) {
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.age = new Float32Array(capacity).fill(DUST_LIFE_S * 2);
    this.rng = seed >>> 0 || 1;
  }

  private rand(): number {
    this.rng ^= this.rng << 13;
    this.rng >>>= 0;
    this.rng ^= this.rng >>> 17;
    this.rng ^= this.rng << 5;
    this.rng >>>= 0;
    return this.rng / 0x100000000;
  }

  /** `count` puffs rising and spreading from a point, `spread` metres wide. */
  emit(x: number, y: number, z: number, count: number, spread = 0.5): void {
    for (let i = 0; i < count; i++) {
      const k = this.next;
      this.next = (this.next + 1) % this.capacity;
      const a = this.rand() * Math.PI * 2;
      const r = this.rand() * spread;
      this.px[k] = x + Math.cos(a) * r * 0.3;
      this.py[k] = y;
      this.pz[k] = z + Math.sin(a) * r * 0.3;
      this.vx[k] = Math.cos(a) * r;
      this.vy[k] = 0.5 + this.rand() * 0.6;
      this.vz[k] = Math.sin(a) * r;
      this.age[k] = 0;
    }
  }

  step(dt: number): void {
    const drag = Math.max(0, 1 - 2 * dt);
    for (let k = 0; k < this.capacity; k++) {
      if (this.age[k]! >= DUST_LIFE_S) continue;
      this.age[k] = this.age[k]! + dt;
      this.px[k] = this.px[k]! + this.vx[k]! * dt;
      this.py[k] = this.py[k]! + this.vy[k]! * dt;
      this.pz[k] = this.pz[k]! + this.vz[k]! * dt;
      this.vx[k] = this.vx[k]! * drag;
      this.vz[k] = this.vz[k]! * drag;
      this.vy[k] = this.vy[k]! * drag;
    }
  }

  alive(): number {
    let n = 0;
    for (let k = 0; k < this.capacity; k++) if (this.age[k]! < DUST_LIFE_S) n++;
    return n;
  }
}

/** Puffs for a blow that took `lost` of a prop's health (a fraction): a few for a nick, more for a heavy hit. */
export const puffsFor = (lost: number): number => Math.max(3, Math.min(12, Math.round(3 + lost * 20)));
