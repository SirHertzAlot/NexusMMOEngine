/**
 * Break pieces (DE2): the pooled simulation behind what a broken prop throws. Client only: nothing here
 * replicates, so it costs the server nothing. A fixed ring of pieces; when it is full the oldest is
 * overwritten, so a flood of breaks costs the same as one. Pieces are thrown from the prop, fall, bounce
 * once on the ground, slide to rest, lie a while and shrink away.
 *
 * Pure arrays: the layer draws them. The ground is a callback (the terrain), so the sim never needs THREE.
 */

export const DEBRIS_CAPACITY = 192;
/** Seconds a piece exists, including the last `SHRINK_S` spent shrinking. */
export const DEBRIS_LIFE_S = 6;
export const SHRINK_S = 1;
const GRAVITY = 9.8;
const RESTITUTION = 0.3;
const GROUND_FRICTION = 6;

export type GroundAt = (x: number, z: number) => number;

export class DebrisSim {
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  /** Euler angles about each axis, radians. */
  readonly rx: Float32Array;
  readonly ry: Float32Array;
  readonly rz: Float32Array;
  /** Half the piece's edge, metres (a piece is a cube). */
  readonly half: Float32Array;
  /** Colour, 0xRRGGBB. */
  readonly color: Uint32Array;
  /** Seconds lived; at or past DEBRIS_LIFE_S the piece is gone. */
  readonly age: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly wx: Float32Array;
  private readonly wy: Float32Array;
  private readonly wz: Float32Array;
  private readonly rested: Uint8Array;
  private next = 0;
  private rng: number;

  constructor(readonly capacity = DEBRIS_CAPACITY, seed = 1) {
    const f = (): Float32Array => new Float32Array(capacity);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.rx = f();
    this.ry = f();
    this.rz = f();
    this.half = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.wx = f();
    this.wy = f();
    this.wz = f();
    this.color = new Uint32Array(capacity);
    this.age = f().fill(DEBRIS_LIFE_S * 2);
    this.rested = new Uint8Array(capacity);
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

  /**
   * Throw `count` pieces from a prop standing at (x, y, z) with half extents (hx, hy, hz): each starts inside
   * its box and flies outward from the centre, the lighter the faster. `color` is the prop's colour.
   */
  burst(x: number, y: number, z: number, hx: number, hy: number, hz: number, count: number, color: number): void {
    // A piece is about a fifth of the prop's smallest span, never a speck or a boulder.
    const span = Math.min(hx, hy, hz) * 2;
    const base = Math.max(0.05, Math.min(0.35, span * 0.2));
    for (let i = 0; i < count; i++) {
      const k = this.next;
      this.next = (this.next + 1) % this.capacity;
      const ox = (this.rand() * 2 - 1) * hx;
      const oy = (this.rand() * 2 - 1) * hy;
      const oz = (this.rand() * 2 - 1) * hz;
      this.px[k] = x + ox;
      this.py[k] = y + hy + oy;
      this.pz[k] = z + oz;
      const out = Math.hypot(ox, oz) || 1;
      const speed = 1.5 + this.rand() * 2.5;
      this.vx[k] = (ox / out) * speed;
      this.vz[k] = (oz / out) * speed;
      this.vy[k] = 2 + this.rand() * 3;
      this.wx[k] = (this.rand() * 2 - 1) * 8;
      this.wy[k] = (this.rand() * 2 - 1) * 8;
      this.wz[k] = (this.rand() * 2 - 1) * 8;
      this.rx[k] = this.rand() * 6.28;
      this.ry[k] = this.rand() * 6.28;
      this.rz[k] = this.rand() * 6.28;
      this.half[k] = (base * (0.6 + this.rand() * 0.8)) / 2;
      this.color[k] = color;
      this.age[k] = 0;
      this.rested[k] = 0;
    }
  }

  step(dt: number, groundAt: GroundAt = () => 0): void {
    for (let k = 0; k < this.capacity; k++) {
      if (this.age[k]! >= DEBRIS_LIFE_S) continue;
      this.age[k] = this.age[k]! + dt;
      if (this.rested[k]) continue;
      this.vy[k] = this.vy[k]! - GRAVITY * dt;
      this.px[k] = this.px[k]! + this.vx[k]! * dt;
      this.py[k] = this.py[k]! + this.vy[k]! * dt;
      this.pz[k] = this.pz[k]! + this.vz[k]! * dt;
      this.rx[k] = this.rx[k]! + this.wx[k]! * dt;
      this.ry[k] = this.ry[k]! + this.wy[k]! * dt;
      this.rz[k] = this.rz[k]! + this.wz[k]! * dt;
      const floor = groundAt(this.px[k]!, this.pz[k]!) + this.half[k]!;
      if (this.py[k]! <= floor) {
        this.py[k] = floor;
        if (this.vy[k]! < -1) {
          this.vy[k] = -this.vy[k]! * RESTITUTION;
        } else {
          this.vy[k] = 0;
          const slow = Math.max(0, 1 - GROUND_FRICTION * dt);
          this.vx[k] = this.vx[k]! * slow;
          this.vz[k] = this.vz[k]! * slow;
          this.wx[k] = this.wx[k]! * slow;
          this.wy[k] = this.wy[k]! * slow;
          this.wz[k] = this.wz[k]! * slow;
          if (Math.hypot(this.vx[k]!, this.vz[k]!) < 0.05) this.rested[k] = 1;
        }
      }
    }
  }

  alive(): number {
    let n = 0;
    for (let k = 0; k < this.capacity; k++) if (this.age[k]! < DEBRIS_LIFE_S) n++;
    return n;
  }

  /** How big a piece is drawn, 0..1: whole until its last second, then shrinking to nothing. */
  scaleOf(k: number): number {
    const left = DEBRIS_LIFE_S - this.age[k]!;
    return left <= 0 ? 0 : Math.min(1, left / SHRINK_S);
  }
}

/** Pieces for a prop of this half-extent volume (m^3): a few for a crate, a dozen for a hut, never more than 14. */
export function piecesFor(hx: number, hy: number, hz: number): number {
  const volume = 8 * hx * hy * hz;
  return Math.max(5, Math.min(14, Math.round(5 + Math.cbrt(volume) * 4)));
}
