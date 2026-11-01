/**
 * SharedBodyTracks: draws shared bodies (other players, server-simulated
 * creatures) from the server's snapshots, a little behind the clock, instead of
 * the mirror's two-tick blend. It listens to the mirror's Interpolator, so it
 * sees every applied tick, and it only buffers entities the layer has asked
 * for, so props and terrain cost nothing here.
 *
 * Cosmetic only. The local player is predicted (WalkerPredictor), not drawn from here.
 */

import type { TransformRow } from "@mmo-engine/protocol";
import { SnapshotInterpolator } from "../physics/snapshot-interpolator.js";

/** Where a body is drawn: position, rotation (xyzw) and scale. */
export interface BodyPose {
  px: number; py: number; pz: number;
  qx: number; qy: number; qz: number; qw: number;
  sx: number; sy: number; sz: number;
}

/** The part of the mirror's Interpolator this needs: subscribe to pushes. */
export interface PushSource {
  onPush(listener: (tick: number, rows: readonly TransformRow[]) => void): () => void;
}

export interface SharedBodyOptions {
  /** How far behind the clock shared bodies are drawn, seconds. */
  readonly delaySeconds: number;
  /** Snapshots kept per body. */
  readonly capacity?: number;
}

interface Track {
  readonly interp: SnapshotInterpolator;
  sx: number;
  sy: number;
  sz: number;
}

export class SharedBodyTracks {
  private readonly wanted = new Set<bigint>();
  private readonly tracks = new Map<bigint, Track>();
  private tickHz = 0;

  constructor(private readonly options: SharedBodyOptions) {}

  /** Seconds per server tick at `hz`. Buffers are rebuilt when the rate changes (it can change on reconnect). */
  setTickHz(hz: number): void {
    if (hz === this.tickHz) return;
    this.tickHz = hz;
    this.tracks.clear();
  }

  /** The layer draws this entity from snapshots from now on. */
  want(wid: bigint): void {
    this.wanted.add(wid);
  }

  /** Feeds one applied tick. Only wanted entities are buffered. */
  feed(tick: number, rows: readonly TransformRow[]): void {
    if (this.tickHz <= 0) return;
    for (const row of rows) {
      if (!this.wanted.has(row.wireId)) continue;
      let track = this.tracks.get(row.wireId);
      if (!track) {
        track = {
          interp: new SnapshotInterpolator({
            tickSeconds: 1 / this.tickHz,
            delaySeconds: this.options.delaySeconds,
            capacity: this.options.capacity,
          }),
          sx: row.sx, sy: row.sy, sz: row.sz,
        };
        this.tracks.set(row.wireId, track);
      }
      track.interp.push({
        tick,
        pos: { x: row.px, y: row.py, z: row.pz },
        quat: { x: row.qx, y: row.qy, z: row.qz, w: row.qw },
      });
      track.sx = row.sx; track.sy = row.sy; track.sz = row.sz;
    }
  }

  /**
   * The body's pose at server time `nowSeconds` (drawn `delaySeconds` behind it).
   * Undefined when the entity has no snapshots yet; the caller falls back then.
   */
  sample(wid: bigint, nowSeconds: number): BodyPose | undefined {
    const track = this.tracks.get(wid);
    if (!track) return undefined;
    const pose = track.interp.sample(nowSeconds);
    if (!pose) return undefined;
    return {
      px: pose.pos.x, py: pose.pos.y, pz: pose.pos.z,
      qx: pose.quat.x, qy: pose.quat.y, qz: pose.quat.z, qw: pose.quat.w,
      sx: track.sx, sy: track.sy, sz: track.sz,
    };
  }

  /** Stop drawing this entity from snapshots and drop its buffer (it despawned). */
  forget(wid: bigint): void {
    this.wanted.delete(wid);
    this.tracks.delete(wid);
  }

  /** Listen to a mirror Interpolator's pushes. Returns the unsubscribe function. */
  attach(source: PushSource): () => void {
    return source.onPush((tick, rows) => this.feed(tick, rows));
  }
}
