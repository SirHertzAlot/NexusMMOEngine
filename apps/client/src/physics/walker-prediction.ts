/**
 * Client-side prediction for the local player's walker. The client moves its
 * walker ahead of the server with the same inputs. When a server snapshot
 * arrives, it rewinds the walker to the server's position at that tick and
 * replays the inputs since. The error is shown as a visual offset that decays
 * over time instead of a snap, so the player sees a smooth correction.
 *
 * The predictor owns its own world (terrain and props only). Cosmetic rigs
 * live in another world, so replay does not step them twice.
 */

import type { PhysicsWorld, Vec3 } from "./physics-world.js";

export interface PredictionOptions {
  /** Seconds for a visual correction to fall to 1/e of its size. */
  readonly blendSeconds: number;
  /** Corrections above this many metres are applied at once, not blended. */
  readonly snapMetres: number;
}

export interface Snapshot {
  /** The client tick the server's position is for. */
  readonly tick: number;
  /** The walker centre on the server after `tick`. */
  readonly pos: Vec3;
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

export class WalkerPredictor {
  private tick = 0;
  private pos: Vec3;
  private offset: Vec3 = ZERO;
  private readonly inputs = new Map<number, Vec3>();
  private readonly history = new Map<number, Vec3>();

  constructor(
    private readonly world: PhysicsWorld,
    private readonly handle: number,
    private readonly dt: number,
    private readonly opts: PredictionOptions,
    start: Vec3,
    private readonly keepTicks = 240,
  ) {
    this.pos = start;
    this.history.set(0, start);
  }

  /** The tick the client has reached. */
  get currentTick(): number {
    return this.tick;
  }

  /** The predicted walker centre, without the visual offset. */
  get predicted(): Vec3 {
    return this.pos;
  }

  /** Where the player should be drawn: the prediction plus the decaying correction. */
  get visual(): Vec3 {
    return add(this.pos, this.offset);
  }

  /** Advance one client tick with this tick's input: a displacement in metres. */
  step(input: Vec3): void {
    this.tick++;
    this.inputs.set(this.tick, input);
    this.pos = this.advance(input);
    this.history.set(this.tick, this.pos);
    this.trim();
  }

  /**
   * Apply a server snapshot. Returns the error in metres between the predicted
   * and server position at the snapshot's tick, or NaN if that tick is too old.
   */
  onSnapshot(s: Snapshot): number {
    const known = this.history.get(s.tick);
    if (!known) return Number.NaN;
    const error = len(sub(known, s.pos));
    if (error < 1e-4) return error;

    // Rewind to the server state and replay the inputs since that tick.
    const before = this.visual;
    this.world.teleportWalker(this.handle, s.pos);
    let p = s.pos;
    this.history.set(s.tick, p);
    for (let t = s.tick + 1; t <= this.tick; t++) {
      p = this.advance(this.inputs.get(t) ?? ZERO);
      this.history.set(t, p);
    }
    this.pos = p;

    // Keep the drawn position continuous; blend the rest out, or snap if it is large.
    const jump = sub(before, p);
    this.offset = len(jump) > this.opts.snapMetres ? ZERO : jump;
    return error;
  }

  /** Decay the visual offset by `seconds` of wall time. Call once per frame. */
  decay(seconds: number): void {
    const k = Math.exp(-seconds / this.opts.blendSeconds);
    this.offset = { x: this.offset.x * k, y: this.offset.y * k, z: this.offset.z * k };
  }

  private advance(input: Vec3): Vec3 {
    const next = this.world.moveWalker(this.handle, input);
    this.world.step(this.dt);
    return { x: next.x, y: next.y, z: next.z };
  }

  private trim(): void {
    const oldest = this.tick - this.keepTicks;
    for (const t of this.history.keys()) if (t < oldest) this.history.delete(t);
    for (const t of this.inputs.keys()) if (t < oldest) this.inputs.delete(t);
  }
}
