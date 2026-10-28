/**
 * Gameplay mechanics for dungeon procedural model synthesis:
 * - Combination-style puzzles (limited set of choices, clues placed before entrypoint, unlocks doors/chests).
 * - Hidden collision-triggered traps (bounding trigger volumes, animation invocation, and damage events).
 */

import type {
  CombinationPuzzleDefinition,
  CollisionTrapDefinition,
  PuzzleInputSlot,
  PuzzleCluePlacement,
  TransformData,
  Vec3Tuple,
} from "./types.js";

export interface CombinationResult {
  solved: boolean;
  targetUnlocked: boolean;
  animationToPlay?: string;
  message: string;
}

export interface TrapCollisionResult {
  triggered: boolean;
  damageDealt: number;
  animationPlayed?: string;
  knockback?: Vec3Tuple;
  message: string;
}

/**
 * Evaluates a candidate combination against a puzzle definition.
 * Unlocks the target door or chest if the candidate sequence matches the solution.
 */
export function evaluateCombination(
  puzzle: CombinationPuzzleDefinition,
  candidateInputs: string[]
): CombinationResult {
  if (candidateInputs.length !== puzzle.solution.length) {
    return {
      solved: false,
      targetUnlocked: false,
      message: `Invalid combination length: expected ${puzzle.solution.length} inputs, got ${candidateInputs.length}.`,
    };
  }

  // Validate that all inputs belong to the limited options set for their respective slots
  for (let i = 0; i < candidateInputs.length; i++) {
    const slot = puzzle.entrypoint.inputs[i];
    if (slot && !slot.options.includes(candidateInputs[i])) {
      return {
        solved: false,
        targetUnlocked: false,
        message: `Input '${candidateInputs[i]}' is not a valid option for slot ${i + 1}. Permitted: ${slot.options.join(", ")}.`,
      };
    }
  }

  // Check if inputs match the solution vector
  const matches = candidateInputs.every((val, idx) => val === puzzle.solution[idx]);

  if (matches) {
    puzzle.target.isLocked = false;
    for (let i = 0; i < candidateInputs.length; i++) {
      if (puzzle.entrypoint.inputs[i]) {
        puzzle.entrypoint.inputs[i].currentState = candidateInputs[i];
      }
    }
    return {
      solved: true,
      targetUnlocked: true,
      animationToPlay: puzzle.onUnlock.animation,
      message: `Combination accepted! ${puzzle.target.type.toUpperCase()} unlocked with animation '${puzzle.onUnlock.animation}', granting access to ${puzzle.onUnlock.grantsAccessTo}.`,
    };
  }

  return {
    solved: false,
    targetUnlocked: false,
    message: "Incorrect combination sequence. The tumblers snap back to their default alignment.",
  };
}

/**
 * Invokes collision detection between a player entity and a hidden trap trigger volume.
 * Triggers an animation and delivers damage upon collision event invocation.
 */
export function invokeTrapCollision(
  trap: CollisionTrapDefinition,
  playerPos: Vec3Tuple,
  playerRadius = 0.4,
  playerHeight = 1.8
): TrapCollisionResult {
  if (trap.state !== "armed") {
    return {
      triggered: false,
      damageDealt: 0,
      message: `Trap '${trap.trapId}' is ${trap.state} and cannot be triggered.`,
    };
  }

  const [px, py, pz] = playerPos;
  const pMinX = px - playerRadius;
  const pMaxX = px + playerRadius;
  const pMinY = py;
  const pMaxY = py + playerHeight;
  const pMinZ = pz - playerRadius;
  const pMaxZ = pz + playerRadius;

  const [tMinX, tMinY, tMinZ] = trap.triggerVolume.boundsMin;
  const [tMaxX, tMaxY, tMaxZ] = trap.triggerVolume.boundsMax;

  // AABB Overlap check
  const overlapX = pMinX <= tMaxX && pMaxX >= tMinX;
  const overlapY = pMinY <= tMaxY && pMaxY >= tMinY;
  const overlapZ = pMinZ <= tMaxZ && pMaxZ >= tMinZ;

  if (overlapX && overlapY && overlapZ) {
    trap.state = "triggered";
    return {
      triggered: true,
      damageDealt: trap.onCollision.damage,
      animationPlayed: trap.onCollision.animation,
      knockback: trap.onCollision.knockbackVec,
      message: `Collision event invoked on hidden spot [${trap.trapType}]! Playing animation '${trap.onCollision.animation}' and dealing ${trap.onCollision.damage} ${trap.onCollision.damageType} damage.`,
    };
  }

  return {
    triggered: false,
    damageDealt: 0,
    message: "No collision with trap trigger volume.",
  };
}

/**
 * Resets a trap to its armed state after its cooldown interval.
 */
export function resetTrap(trap: CollisionTrapDefinition): void {
  trap.state = "armed";
}

/**
 * Disarms a trap (e.g. via puzzle lever or disarm interaction).
 */
export function disarmTrap(trap: CollisionTrapDefinition): void {
  trap.state = "disarmed";
}
