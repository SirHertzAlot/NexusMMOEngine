/**
 * Far level of detail for animals (roadmap WL2, far-LOD from the instanced batch).
 *
 * An animal beyond ANIMAL_LOD_RADIUS holds its rest pose; past this slice it is not drawn as its
 * own posed mesh at all. It becomes one instance in the shared InstancedProps batch (a stand-in
 * box or sphere sized to its body, one draw call for every far animal of its kind), and comes back
 * to its own mesh when the camera gets near again.
 *
 * Hysteresis: an animal switches to far at radius + HYSTERESIS and back to near at radius −
 * HYSTERESIS, so one standing on the boundary does not flip between the two every frame.
 */

import { ANIMAL_LOD_RADIUS } from "./animal-rig.js";

/** Metres of slack either side of the radius (switch-over band). */
export const ANIMAL_FAR_HYSTERESIS = 3;

/**
 * The far/near state after a frame at `distance` metres from the camera.
 * `wasFar` is last frame's state (false for an animal not yet seen).
 */
export function animalIsFar(wasFar: boolean, distance: number): boolean {
  if (wasFar) return distance >= ANIMAL_LOD_RADIUS - ANIMAL_FAR_HYSTERESIS;
  return distance > ANIMAL_LOD_RADIUS + ANIMAL_FAR_HYSTERESIS;
}
