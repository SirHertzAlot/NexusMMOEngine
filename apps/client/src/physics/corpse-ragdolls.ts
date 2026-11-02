/**
 * Ragdoll corpses for dying creatures, on the client's physics seam. Each corpse
 * is a ragdoll rig over a small piece of ground, both owned here. At most
 * `maxCorpses` are alive: a new death past the cap removes the oldest corpse.
 * A corpse lives `lifetimeSeconds`, then it and its ground are removed.
 *
 * Cosmetic only: corpses never affect gameplay and the server does not see them.
 */

import type { PhysicsWorld, Vec3 } from "./physics-world.js";

export interface CorpseOptions {
  /** Most corpses at once. A death past this removes the oldest corpse. */
  readonly maxCorpses: number;
  /** Seconds a corpse stays before it is removed. */
  readonly lifetimeSeconds: number;
  /** Half the side of the ground square under each corpse, metres. */
  readonly groundHalf: number;
}

export const DEFAULT_CORPSE_OPTIONS: CorpseOptions = {
  maxCorpses: 20,
  lifetimeSeconds: 4,
  groundHalf: 2,
};

/** The rig starts this far above the ground under its root, so it falls onto it. */
const DROP_HEIGHT = 0.6;
/** Thickness of the ground box, metres. Its top sits at the root's height. */
const GROUND_THICKNESS = 0.5;

interface Corpse {
  readonly key: number;
  readonly rig: number;
  readonly ground: number;
  age: number;
}

export class CorpseRagdolls {
  /** Oldest first. */
  private readonly corpses: Corpse[] = [];

  constructor(
    private readonly world: PhysicsWorld,
    private readonly options: CorpseOptions = DEFAULT_CORPSE_OPTIONS,
  ) {}

  /** Corpses alive now. */
  get size(): number {
    return this.corpses.length;
  }

  has(key: number): boolean {
    return this.corpses.some((c) => c.key === key);
  }

  /**
   * A creature died at `root` (its feet). Returns false if `key` already has a
   * corpse; otherwise true, after evicting the oldest corpse if the cap is full.
   */
  spawn(key: number, root: Vec3): boolean {
    if (this.has(key)) return false;
    if (this.options.maxCorpses <= 0) return false;
    while (this.corpses.length >= this.options.maxCorpses) {
      this.remove(this.corpses[0]!.key);
    }
    const h = this.options.groundHalf;
    const ground = this.world.addStaticBox(
      { x: root.x, y: root.y - GROUND_THICKNESS / 2, z: root.z },
      { x: h, y: GROUND_THICKNESS / 2, z: h },
    );
    const rig = this.world.spawnRagdoll({ x: root.x, y: root.y + DROP_HEIGHT, z: root.z });
    this.corpses.push({ key, rig, ground, age: 0 });
    return true;
  }

  /**
   * Writes a corpse's part poses (7 floats per part, see PhysicsWorld.ragdollPartPoses).
   * Returns false if there is no such corpse, and leaves `out` alone.
   */
  pose(key: number, out: Float32Array): boolean {
    const c = this.corpses.find((x) => x.key === key);
    if (!c) return false;
    this.world.ragdollPartPoses(c.rig, out);
    return true;
  }

  /** Remove a corpse and its ground. Unknown keys are ignored. */
  remove(key: number): void {
    const i = this.corpses.findIndex((c) => c.key === key);
    if (i < 0) return;
    const [c] = this.corpses.splice(i, 1);
    this.world.removeRagdoll(c!.rig);
    this.world.removeStaticBox(c!.ground);
  }

  /**
   * Advances the world by `dt` seconds and ages the corpses. Steps the world only
   * when there is a corpse, so an idle client pays nothing.
   */
  update(dt: number): void {
    if (this.corpses.length === 0) return;
    this.world.step(dt);
    for (const c of [...this.corpses]) {
      c.age += dt;
      if (c.age >= this.options.lifetimeSeconds) this.remove(c.key);
    }
  }

  /** Remove every corpse. The world itself is left to its owner. */
  dispose(): void {
    while (this.corpses.length > 0) this.remove(this.corpses[0]!.key);
  }
}
