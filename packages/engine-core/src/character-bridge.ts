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

/** Walkers that move further than this in one tick are teleported. */
export const TELEPORT_DISTANCE = 2;

/** The character calls the bridge needs; the Jolt adapter implements them. */
export interface CharacterBackend {
  addCharacter(id: bigint, radius: number, halfHeight: number, x: number, y: number, z: number): boolean;
  removeCharacter(id: bigint): void;
  setCharacterVelocity(id: bigint, vx: number, vy: number, vz: number): void;
  updateCharacter(id: bigint, dt: number, gx: number, gy: number, gz: number): void;
  characterPosition(id: bigint): [number, number, number];
}

interface Bridged {
  id: bigint;
  /** Distance from the feet to the capsule centre (halfHeight + radius). */
  offset: number;
}

export class CharacterBridgeSystem implements SimSystem {
  readonly name = "character-bridge";
  private readonly walkers = defineQuery([Transform, Velocity, BodyConfig]);
  private readonly bridged = new Map<number, Bridged>();
  private readonly seen = new Set<number>();

  constructor(private readonly backend: CharacterBackend) {}

  /** True if the entity is driven by a character this tick. */
  has(e: number): boolean {
    return this.bridged.has(e);
  }

  step(sim: SimWorld, dtSeconds: number): void {
    const dt = dtSeconds;
    this.seen.clear();
    const list = this.walkers(sim.ecs);
    for (let i = 0; i < list.length; i++) {
      const e = list[i] as number;
      if (BodyConfig.motionType[e] !== MotionType.Kinematic) continue;
      if (hasComponent(sim.ecs, Noclip, e)) continue;
      if (BodyConfig.shapeKind[e] !== ShapeKind.Capsule) continue;
      const radius = BodyConfig.radius[e];
      if (!(radius > 0)) continue;
      const halfHeight = BodyConfig.halfY[e];
      const px = Transform.px[e];
      const py = Transform.py[e];
      const pz = Transform.pz[e];
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
      this.seen.add(e);
      const offset = halfHeight + radius;
      let b = this.bridged.get(e);
      if (!b) {
        b = { id: BigInt(e), offset };
        if (!this.backend.addCharacter(b.id, radius, halfHeight, px, py + offset, pz)) continue;
        this.bridged.set(e, b);
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
    // Walkers that are gone or no longer bridged release their character.
    for (const [e, b] of this.bridged) {
      if (!this.seen.has(e)) {
        this.backend.removeCharacter(b.id);
        this.bridged.delete(e);
      }
    }
  }
}
