/**
 * The rig every ragdoll uses: 11 boxes joined by 10 ball joints. Centres are
 * relative to the rig root, in metres; joined parts only touch, so a rig at
 * rest is not in contact with itself. Same shape as the benchmark's
 * (`scripts/bench-physics.mjs`).
 */

export interface RigPart {
  readonly centre: readonly [number, number, number];
  readonly halfExtents: readonly [number, number, number];
}

export const RIG_PARTS: readonly RigPart[] = [
  { centre: [0, 1.6, 0], halfExtents: [0.1, 0.12, 0.1] }, // head
  { centre: [0, 1.15, 0], halfExtents: [0.2, 0.3, 0.12] }, // chest
  { centre: [0, 0.6, 0], halfExtents: [0.18, 0.12, 0.12] }, // pelvis
  { centre: [-0.35, 1.15, 0], halfExtents: [0.07, 0.25, 0.07] }, // upper arm L
  { centre: [0.35, 1.15, 0], halfExtents: [0.07, 0.25, 0.07] }, // upper arm R
  { centre: [-0.35, 0.66, 0], halfExtents: [0.06, 0.22, 0.06] }, // forearm L
  { centre: [0.35, 0.66, 0], halfExtents: [0.06, 0.22, 0.06] }, // forearm R
  { centre: [-0.12, 0.2, 0], halfExtents: [0.09, 0.2, 0.09] }, // thigh L
  { centre: [0.12, 0.2, 0], halfExtents: [0.09, 0.2, 0.09] }, // thigh R
  { centre: [-0.12, -0.25, 0], halfExtents: [0.08, 0.22, 0.08] }, // shin L
  { centre: [0.12, -0.25, 0], halfExtents: [0.08, 0.22, 0.08] }, // shin R
];

/** Pairs of part indices joined by a ball joint at the midpoint of their centres. */
export const RIG_JOINTS: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [1, 3], [1, 4], [3, 5], [4, 6], [2, 7], [2, 8], [7, 9], [8, 10],
];
