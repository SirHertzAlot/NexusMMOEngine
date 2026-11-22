/**
 * Character bridge: walkers move through the Jolt CharacterVirtual.
 *
 * Each kinematic walker (a capsule, not Noclip) gets one addon character.
 * Each tick the walker's intended feet position (already integrated by
 * IntentSystem and IntegrateSystem) becomes a velocity toward that target;
 * updateCharacter sweeps the capsule against the world's bodies and stops it
 * at their faces. The resolved position is written back to Transform, so the
 * JS prop push-out (PropCollisionSystem) is skipped for these walkers.
 *
 * A walker that jumps further than TELEPORT_DISTANCE (a respawn or a scene
 * teleport) is removed and added again at the target, so the sweep does not
 * have to cross the gap. Walkers that stop being walkers are removed.
 */

import { defineQuery, hasComponent } from "bitecs";
import { BodyConfig, MotionType, Noclip, ShapeKind, Transform, Velocity } from "./components.js";
import type { SimWorld } from "./world.js";
import type { SimSystem } from "./systems.js";
import type { SystemAccess } from "./system-access.js";
import { clearOfStatics } from "./prop-collision.js";

/** Walkers that move further than this in one tick are teleported. */
export const TELEPORT_DISTANCE = 2;

/** Clearance added to the capsule radius when a walker is first placed: a spawn inside a static body is pushed out before its character is created. */
export const SPAWN_CLEARANCE = 0.05;

/** The character calls the bridge needs; the Jolt adapter implements them. */
export interface CharacterBackend {
  addCharacter(id: bigint, radius: number, halfHeight: number, x: number, y: number, z: number): boolean;
  removeCharacter(id: bigint): void;
  setCharacterVelocity(id: bigint, vx: number, vy: number, vz: number): void;
  updateCharacter(id: bigint, dt: number, gx: number, gy: number, gz: number): void;
  characterPosition(id: bigint): [number, number, number];
  /**
   * Optional: the per-walker velocity, update and read-back for many walkers in one call (the physics addon's
   * followCharacters). With it the bridge makes one native call a tick instead of four per walker, and allocates
   * no position arrays; the characters move exactly as with the single calls.
   */
  followCharacters?(ids: BigUint64Array, targets: Float64Array, count: number, dt: number, teleport: number, out: Float32Array): void;
}

interface Bridged {
  id: bigint;
  /** Distance from the feet to the capsule centre (halfHeight + radius). */
  offset: number;
}

export class CharacterBridgeSystem implements SimSystem {
  readonly name = "character-bridge";
  readonly access: SystemAccess = {
    system: "character-bridge",
    reads: [
      "Noclip",
      "Velocity",
      { component: "BodyConfig", fields: ["halfY", "motionType", "radius", "shapeKind"] },
      { component: "Transform", fields: ["px", "py", "pz"] },
    ],
    writes: [
      { component: "Transform", fields: ["px", "py", "pz"] },
    ],
  };
  private readonly walkers = defineQuery([Transform, Velocity, BodyConfig]);
  private readonly bridged = new Map<number, Bridged>();
  private readonly seen = new Set<number>();
  // The batch's buffers (followCharacters), grown as walkers come and kept.
  private batchE = new Int32Array(0);
  private batchIds = new BigUint64Array(0);
  private batchTargets = new Float64Array(0);
  private batchOut = new Float32Array(0);

  /**
   * `enabled: false` makes the system a no-op (nothing is bridged, nothing
   * is moved), so the JS prop push-out keeps the walkers. Off by default in
   * the physics module until the live walker-at-prop check passes.
   */
  constructor(
    private readonly backend: CharacterBackend,
    private readonly enabled: boolean = true,
  ) {}

  /** True if the entity is driven by a character this tick. */
  has(e: number): boolean {
    return this.bridged.has(e);
  }

  step(sim: SimWorld, dtSeconds: number): void {
    if (!this.enabled) return;
    const dt = dtSeconds;
    this.seen.clear();
    const batch = this.backend.followCharacters !== undefined;
    let n = 0;
    const list = this.walkers(sim.ecs);
    for (let i = 0; i < list.length; i++) {
      const e = list[i] as number;
      if (BodyConfig.motionType[e] !== MotionType.Kinematic) continue;
      if (hasComponent(sim.ecs, Noclip, e)) continue;
      if (BodyConfig.shapeKind[e] !== ShapeKind.Capsule) continue;
      const radius = BodyConfig.radius[e];
      if (!(radius > 0)) continue;
      const halfHeight = BodyConfig.halfY[e];
      let px = Transform.px[e];
      const py = Transform.py[e];
      let pz = Transform.pz[e];
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
      this.seen.add(e);
      const offset = halfHeight + radius;
      let b = this.bridged.get(e);
      if (!b) {
        b = { id: BigInt(e), offset };
        // One-time placement: nudge the walker out of any static body it starts in (a spawn inside a wall), so its first sweep does not push it.
        const clear = clearOfStatics(sim, px, pz, radius + SPAWN_CLEARANCE);
        Transform.px[e] = clear.x;
        Transform.pz[e] = clear.z;
        px = clear.x;
        pz = clear.z;
        if (!this.backend.addCharacter(b.id, radius, halfHeight, px, py + offset, pz)) continue;
        this.bridged.set(e, b);
      }
      if (batch) {
        // Queued: the batch below moves them all at once.
        if (n === this.batchE.length) this.grow(Math.max(64, n * 2));
        this.batchE[n] = e;
        this.batchIds[n] = b.id;
        this.batchTargets[3 * n] = px;
        this.batchTargets[3 * n + 1] = py + b.offset;
        this.batchTargets[3 * n + 2] = pz;
        n++;
        continue;
      }
      const cur = this.backend.characterPosition(b.id);
      const tx = px;
      const ty = py + b.offset;
      const tz = pz;
      const dx = tx - cur[0];
      const dy = ty - cur[1];
      const dz = tz - cur[2];
      if (dx * dx + dy * dy + dz * dz > TELEPORT_DISTANCE * TELEPORT_DISTANCE) {
        this.backend.removeCharacter(b.id);
        this.backend.addCharacter(b.id, radius, halfHeight, tx, ty, tz);
      } else if (dt > 0) {
        this.backend.setCharacterVelocity(b.id, dx / dt, dy / dt, dz / dt);
        this.backend.updateCharacter(b.id, dt, 0, 0, 0);
      }
      const at = this.backend.characterPosition(b.id);
      if (!Number.isFinite(at[0])) continue;
      Transform.px[e] = at[0];
      Transform.pz[e] = at[2];
      Transform.py[e] = at[1] - b.offset;
    }
    if (n > 0) {
      this.backend.followCharacters!(this.batchIds, this.batchTargets, n, dt, TELEPORT_DISTANCE, this.batchOut);
      const out = this.batchOut;
      for (let k = 0; k < n; k++) {
        const e = this.batchE[k]!;
        const b = this.bridged.get(e)!;
        let x = out[4 * k]!;
        let y = out[4 * k + 1]!;
        let z = out[4 * k + 2]!;
        if (out[4 * k + 3] === 1) {
          // Too far to sweep: re-created at the target.
          const tx = this.batchTargets[3 * k]!;
          const ty = this.batchTargets[3 * k + 1]!;
          const tz = this.batchTargets[3 * k + 2]!;
          this.backend.removeCharacter(b.id);
          this.backend.addCharacter(b.id, BodyConfig.radius[e]!, BodyConfig.halfY[e]!, tx, ty, tz);
          const at = this.backend.characterPosition(b.id);
          x = at[0];
          y = at[1];
          z = at[2];
        }
        if (!Number.isFinite(x)) continue;
        Transform.px[e] = x;
        Transform.pz[e] = z;
        Transform.py[e] = y - b.offset;
      }
    }
    // Walkers that are gone or no longer bridged release their character.
    for (const [e, b] of this.bridged) {
      if (!this.seen.has(e)) {
        this.backend.removeCharacter(b.id);
        this.bridged.delete(e);
      }
    }
  }

  private grow(size: number): void {
    const e = new Int32Array(size);
    e.set(this.batchE);
    const ids = new BigUint64Array(size);
    ids.set(this.batchIds);
    const targets = new Float64Array(size * 3);
    targets.set(this.batchTargets);
    this.batchE = e;
    this.batchIds = ids;
    this.batchTargets = targets;
    this.batchOut = new Float32Array(size * 4);
  }
}
