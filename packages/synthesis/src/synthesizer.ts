/**
 * Continuous Growth Model Synthesizer.
 *
 * Implements tileless procedural assembly synthesis using learned spatial
 * grammar and socket adjacency distributions.
 *
 * Implements specifications from MODEL-SYNTHESIS-MAP.md §3, §4, §7, §8.
 */

import * as THREE from "three";
import {
  HUMAN_REFERENCE_METRICS,
  ERGONOMIC_REFERENCE_ANCHORS,
  classifyScaleTier,
  analyzeSpatialPerception,
  generateScaleVariance,
  type ScaleTier,
} from "@mmo-engine/scene";
import type {
  SynthesisProblem,
  SynthesisOutput,
  SynthesizedPlacement,
  SynthesisReport,
  SynthesisMeasurementReport,
  TransformData,
  BoundsData,
  Vec3Tuple,
  QuatTuple,
  AdjacencyRule,
  PartDef,
  RoomBlueprint,
  CombinationPuzzleDefinition,
  CollisionTrapDefinition,
  PuzzleInputSlot,
  PuzzleCluePlacement,
  LearnedRuleSet,
} from "./types.js";

/** Mulberry32 deterministic 32-bit PRNG. */
export class DeterministicRng {
  private s: number;

  constructor(seed: number) {
    this.s = (seed | 0) || 1337;
  }

  /** Return next float in [0, 1). */
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Return random integer in [min, max]. */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Weighted pick from items with weights. */
  pickWeighted<T>(items: T[], getWeight: (item: T) => number): T | null {
    if (items.length === 0) return null;
    let totalWeight = 0;
    for (const item of items) {
      totalWeight += Math.max(0.0001, getWeight(item));
    }
    let r = this.next() * totalWeight;
    for (const item of items) {
      const w = Math.max(0.0001, getWeight(item));
      if (r <= w) return item;
      r -= w;
    }
    return items[items.length - 1];
  }
}

interface WorldSocket {
  partIndex: number;
  partId: string;
  socketName: string;
  kind: string;
  worldPos: THREE.Vector3;
  worldNormal: THREE.Vector3;
}

interface BoundingAABB {
  min: THREE.Vector3;
  max: THREE.Vector3;
}

/** Check if two AABBs overlap with a tolerance margin (in metres). */
function aabbIntersects(a: BoundingAABB, b: BoundingAABB, tolerance = 0.15): boolean {
  return (
    a.min.x + tolerance <= b.max.x - tolerance &&
    a.max.x - tolerance >= b.min.x + tolerance &&
    a.min.y + tolerance <= b.max.y - tolerance &&
    a.max.y - tolerance >= b.min.y + tolerance &&
    a.min.z + tolerance <= b.max.z - tolerance &&
    a.max.z - tolerance >= b.min.z + tolerance
  );
}

/** Quantize position to millimetres. */
function quantizeVec3(v: THREE.Vector3): Vec3Tuple {
  return [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000, Math.round(v.z * 1000) / 1000];
}

/** Quantize quaternion to 4 decimal places. */
function quantizeQuat(q: THREE.Quaternion): QuatTuple {
  return [
    Math.round(q.x * 10000) / 10000,
    Math.round(q.y * 10000) / 10000,
    Math.round(q.z * 10000) / 10000,
    Math.round(q.w * 10000) / 10000,
  ];
}

/** Helper to create pure upright yaw rotation quaternion. */
function yawQuat(yawRad: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawRad);
}

/**
 * Structural architectural invariant:
 * - A stair is valid ONLY IF it connects two distinct floor levels together (lower landing and upper landing).
 * - A pillar is valid ONLY IF it rests on a supporting floor beneath AND has a load-bearing structure
 *   directly above it (either an upper floor/loft deck OR an overhead ceiling/roof/vault arch).
 * Any freestanding pillar sitting on a floor with open air above it (random pillar in the middle of a room),
 * or stairs leading into empty air, is rejected.
 */
export function isConnectingTwoFloors(
  placement: SynthesizedPlacement,
  allPlacements: SynthesizedPlacement[],
  ruleSet?: LearnedRuleSet
): boolean {
  if (placement.category !== "stairs" && placement.category !== "pillar") {
    return true;
  }

  const floorPlacements = allPlacements.filter((p) => p.category === "floor");
  if (floorPlacements.length === 0) {
    return false;
  }

  const partDef = ruleSet?.parts[placement.partId];
  const size = partDef ? partDef.bounds.size : [2, 3.5, 2];
  const scale = placement.transform.scale || [1, 1, 1];
  const [px, py, pz] = placement.transform.pos;
  const sy = (size[1] || 3.5) * scale[1];
  const yBase = py - sy / 2;
  const yTop = py + sy / 2;

  if (placement.category === "pillar") {
    // 1. Must rest on a lower floor directly beneath base
    const hasLowerFloor = floorPlacements.some((f) => {
      const [fx, fy, fz] = f.transform.pos;
      const dx = Math.abs(fx - px);
      const dz = Math.abs(fz - pz);
      const dy = Math.abs(fy - yBase);
      return dx <= 3.5 && dz <= 3.5 && dy <= 0.8;
    });
    if (!hasLowerFloor) return false;

    // 2. Must hold up a structure directly above it:
    // Case A: Supporting an upper floor (mezzanine / loft deck)
    const hasUpperFloor = floorPlacements.some((f) => {
      const [fx, fy, fz] = f.transform.pos;
      const dx = Math.abs(fx - px);
      const dz = Math.abs(fz - pz);
      const dy = Math.abs(fy - yTop);
      return dx <= 3.5 && dz <= 3.5 && dy <= 0.8 && fy >= yBase + 1.5;
    });
    if (hasUpperFloor) return true;

    // Case B: Supporting an overhead ceiling / roof / vault arch
    const ceilingPlacements = allPlacements.filter((p) => p.category === "ceiling");
    const hasOverheadCeiling = ceilingPlacements.some((c) => {
      const [cx, cy, cz] = c.transform.pos;
      const dx = Math.abs(cx - px);
      const dz = Math.abs(cz - pz);
      const dy = Math.abs(cy - yTop);
      return dx <= 3.5 && dz <= 3.0 && dy <= 1.2 && cy >= yBase + 1.5;
    });

    return hasOverheadCeiling;
  }

  if (placement.category === "stairs") {
    // Stairs must connect two distinct floor levels together
    const floorHeights = Array.from(
      new Set(floorPlacements.map((f) => Math.round(f.transform.pos[1] * 10) / 10))
    ).sort((a, b) => a - b);

    if (
      floorHeights.length < 2 ||
      floorHeights[floorHeights.length - 1] - floorHeights[0] < 1.5
    ) {
      // Single floor level in room: stairs cannot connect two floors
      return false;
    }

    const sz = (size[2] || 5.0) * scale[2];
    const [qx, qy, qz, qw] = placement.transform.rot;
    // Extract yaw around Y axis
    const siny_cosp = 2 * (qw * qy + qx * qz);
    const cosy_cosp = 1 - 2 * (qy * qy + qz * qz);
    const yaw = Math.atan2(siny_cosp, cosy_cosp);

    // Standard stair: bottom landing at local +Z, top landing at local -Z
    const xBot = px + Math.sin(yaw) * (sz / 2);
    const zBot = pz + Math.cos(yaw) * (sz / 2);
    const xTop = px - Math.sin(yaw) * (sz / 2);
    const zTop = pz - Math.cos(yaw) * (sz / 2);

    const hasLowerFloor = floorPlacements.some((f) => {
      const [fx, fy, fz] = f.transform.pos;
      const dx = Math.abs(fx - xBot);
      const dz = Math.abs(fz - zBot);
      const dy = Math.abs(fy - yBase);
      return dx <= 3.8 && dz <= 3.8 && dy <= 1.0;
    });

    const hasUpperFloor = floorPlacements.some((f) => {
      const [fx, fy, fz] = f.transform.pos;
      const dx = Math.abs(fx - xTop);
      const dz = Math.abs(fz - zTop);
      const dy = Math.abs(fy - yTop);
      return dx <= 3.8 && dz <= 3.8 && dy <= 1.0 && fy >= yBase + 1.5;
    });

    return hasLowerFloor && hasUpperFloor;
  }

  return true;
}

/**
 * Continuous spatial model synthesizer.
 *
 * Implements the hybrid architectural pattern:
 * When given a comprehensive architectural rule set, it constructs structurally sound
 * dungeon spaces (crypt halls, boss arenas, multi-level descents) adhering to classical
 * architectural principles (continuous foundation, perimeter enclosure, tectonic colonnades,
 * circulation stairs, and contextual props).
 * When given arbitrary generic rules, it runs entropy-guided socket growth with strict
 * upright yaw and grounding enforcement.
 */
export function synthesizeAssembly(problem: SynthesisProblem): SynthesisOutput {
  const startTime = Date.now();
  const rng = new DeterministicRng(problem.seed);
  const ruleSet = problem.ruleSet;
  const maxParts = Math.max(1, problem.budget.maxParts);
  const maxGrowthAttempts = problem.budget.maxGrowthAttempts ?? maxParts * 25;

  const placements: SynthesizedPlacement[] = [];
  const placedAABBs: BoundingAABB[] = [];
  const openSockets: WorldSocket[] = [];
  const categoryCounts: Record<string, number> = {};
  const scaleTierCounts: Record<string, number> = {
    micro: 0,
    handheld: 0,
    human: 0,
    ogre: 0,
    monumental: 0,
    colossal: 0,
  };

  const siteMin = new THREE.Vector3(...problem.site.bounds.min);
  const siteMax = new THREE.Vector3(...problem.site.bounds.max);

  // Helper to place a part
  const addPlacement = (
    partDef: PartDef,
    pos: THREE.Vector3,
    rot: THREE.Quaternion,
    scale: THREE.Vector3 = new THREE.Vector3(1, 1, 1),
    ignoreSocketName?: string
  ): number => {
    if (placements.length >= maxParts) return -1;

    const partIdx = placements.length;
    const cat = partDef.category;
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;

    const [sx, sy, sz] = partDef.bounds.size;
    const maxDimM = Math.max(sx * scale.x, sy * scale.y, sz * scale.z);
    const tier = classifyScaleTier(maxDimM);
    scaleTierCounts[tier] = (scaleTierCounts[tier] || 0) + 1;
    const halfSize = new THREE.Vector3((sx * scale.x) / 2, (sy * scale.y) / 2, (sz * scale.z) / 2);
    const boxMin = new THREE.Vector3().subVectors(pos, halfSize);
    const boxMax = new THREE.Vector3().addVectors(pos, halfSize);
    placedAABBs.push({ min: boxMin, max: boxMax });

    placements.push({
      partId: partDef.id,
      assetRef: partDef.assetRef,
      category: cat,
      transform: {
        pos: quantizeVec3(pos),
        rot: quantizeQuat(rot),
        scale: [Math.round(scale.x * 100) / 100, Math.round(scale.y * 100) / 100, Math.round(scale.z * 100) / 100],
      },
      size: [sx * scale.x, sy * scale.y, sz * scale.z],
    });

    for (const s of partDef.sockets) {
      if (ignoreSocketName && s.name === ignoreSocketName) continue;
      const localOff = new THREE.Vector3(...s.offset);
      const localNorm = new THREE.Vector3(...s.normal);
      const worldPos = localOff.clone().applyQuaternion(rot).add(pos);
      const worldNormal = localNorm.clone().applyQuaternion(rot).normalize();

      openSockets.push({
        partIndex: partIdx,
        partId: partDef.id,
        socketName: s.name,
        kind: s.kind,
        worldPos,
        worldNormal,
      });
    }

    return partIdx;
  };

  // Group parts by category
  const partsByCat: Record<string, PartDef[]> = {};
  for (const p of Object.values(ruleSet.parts)) {
    if (!partsByCat[p.category]) partsByCat[p.category] = [];
    partsByCat[p.category].push(p);
  }

  const pickCatPart = (cat: string, filterKeyword?: string): PartDef | null => {
    let list = partsByCat[cat];
    if (!list || list.length === 0) {
      if (cat === "trap" || cat === "puzzle") {
        list = partsByCat["prop"] || partsByCat["structure"] || [];
      } else {
        return null;
      }
    }
    if (filterKeyword) {
      const filtered = list.filter((p) => p.id.toLowerCase().includes(filterKeyword.toLowerCase()));
      if (filtered.length > 0) list = filtered;
    }
    return rng.pickWeighted(list, (p) => ruleSet.stats.partFrequencies?.[p.id] || 1) ?? list[0];
  };

  // Check if we have rich architectural categories
  const hasArchitecture =
    (partsByCat["floor"]?.length || 0) > 0 &&
    (partsByCat["wall"]?.length || 0) > 0;

  // Determine archetype
  let archetype = problem.blueprint?.archetype;
  if (!archetype) {
    const spanX = siteMax.x - siteMin.x;
    const spanY = siteMax.y - siteMin.y;
    const spanZ = siteMax.z - siteMin.z;

    if (spanY >= 12 && (partsByCat["stairs"]?.length || 0) > 0) {
      archetype = "multi-level-descent";
    } else if (spanX >= 45 || spanZ >= 45) {
      archetype = "boss-arena";
    } else {
      archetype = "crypt-hall";
    }
  }

  const generatedPuzzles: CombinationPuzzleDefinition[] = [];
  const generatedTraps: CollisionTrapDefinition[] = [];

  // 1. ARCHITECTURAL BLUEPRINT SYNTHESIS
  if (hasArchitecture) {
    const groundY = siteMin.y + 0.1;
    const floorList = partsByCat["floor"] || [];
    const wallList = partsByCat["wall"] || [];
    const doorList = partsByCat["door"] || wallList;
    const pillarList = partsByCat["pillar"] || [];
    const stairsList = partsByCat["stairs"] || [];
    const ceilingList = partsByCat["ceiling"] || [];
    const railingList = partsByCat["railing"] || [];
    const propList = partsByCat["prop"] || [];
    const rubbleList = partsByCat["rubble"] || [];

    if (archetype === "crypt-hall") {
      // Symmetrical 3x6 bay Crypt Hall (15m x 30m)
      const baysX = 3;
      const baysZ = 6;
      const cellM = 5.0;

      // Phase 1: Continuous Floor Grid
      for (let iz = 0; iz < baysZ; iz++) {
        for (let ix = 0; ix < baysX; ix++) {
          const x = (ix - (baysX - 1) / 2) * cellM;
          const z = (iz - (baysZ - 1) / 2) * cellM;
          const floorPart = pickCatPart("floor");
          if (floorPart) {
            addPlacement(floorPart, new THREE.Vector3(x, groundY, z), yawQuat(0));
          }
        }
      }

      // Phase 2: Inward-facing Perimeter Enclosure
      // South wall (iz = 0, z = -12.5, wall at z - 2.5 = -15.0)
      for (let ix = 0; ix < baysX; ix++) {
        const x = (ix - (baysX - 1) / 2) * cellM;
        const z = -((baysZ - 1) / 2) * cellM - cellM / 2;
        const isDoorway = ix === 1; // Center bay is entrance portal
        const def = isDoorway ? (pickCatPart("door") || pickCatPart("wall")) : pickCatPart("wall");
        if (def) {
          addPlacement(def, new THREE.Vector3(x, groundY + 2.0, z), yawQuat(0)); // Facing North
        }
      }

      // North wall (iz = 5, z = 12.5, wall at z + 2.5 = 15.0)
      for (let ix = 0; ix < baysX; ix++) {
        const x = (ix - (baysX - 1) / 2) * cellM;
        const z = ((baysZ - 1) / 2) * cellM + cellM / 2;
        const def = pickCatPart("wall");
        if (def) {
          addPlacement(def, new THREE.Vector3(x, groundY + 2.0, z), yawQuat(Math.PI)); // Facing South
        }
      }

      // West wall (ix = 0, x = -5.0, wall at x - 2.5 = -7.5)
      for (let iz = 0; iz < baysZ; iz++) {
        const x = -((baysX - 1) / 2) * cellM - cellM / 2;
        const z = (iz - (baysZ - 1) / 2) * cellM;
        const def = pickCatPart("wall");
        if (def) {
          addPlacement(def, new THREE.Vector3(x, groundY + 2.0, z), yawQuat(-Math.PI / 2)); // Facing East
        }
      }

      // East wall (ix = 2, x = 5.0, wall at x + 2.5 = 7.5)
      for (let iz = 0; iz < baysZ; iz++) {
        const x = ((baysX - 1) / 2) * cellM + cellM / 2;
        const z = (iz - (baysZ - 1) / 2) * cellM;
        const def = pickCatPart("wall");
        if (def) {
          addPlacement(def, new THREE.Vector3(x, groundY + 2.0, z), yawQuat(Math.PI / 2)); // Facing West
        }
      }

      // Phase 3: Nave Colonnade Columns supporting the Overhead Vault Roof (x = -2.5, +2.5)
      if (pillarList.length > 0 && ceilingList.length > 0) {
        for (let iz = 1; iz < baysZ - 1; iz++) {
          const z = (iz - (baysZ - 1) / 2) * cellM;
          for (const colX of [-2.5, 2.5]) {
            const pillarDef = pickCatPart("pillar");
            if (pillarDef) {
              addPlacement(pillarDef, new THREE.Vector3(colX, groundY + 2.0, z), yawQuat(0));
            }
          }
        }
      }

      // Phase 4: Overhead Ceiling Arches
      if (ceilingList.length > 0) {
        for (let iz = 1; iz < baysZ - 1; iz++) {
          const z = (iz - (baysZ - 1) / 2) * cellM;
          const ceilDef = pickCatPart("ceiling");
          if (ceilDef) {
            addPlacement(ceilDef, new THREE.Vector3(0, groundY + 4.0, z), yawQuat(0));
          }
        }
      }

      // Phase 5: Focal Altar / Shrine at Nave Terminus
      const focalDef = pickCatPart("prop") || pickCatPart("structure");
      if (focalDef) {
        addPlacement(focalDef, new THREE.Vector3(0, groundY + 0.6, ((baysZ - 1) / 2) * cellM - 1.5), yawQuat(0));
      }

      // Phase 6: Corner Rubble / Props with Calibrated Scale Variance
      for (const rx of [-6.0, 6.0]) {
        for (const rz of [-13.5, 13.5]) {
          const rDef = pickCatPart("rubble") || pickCatPart("prop");
          if (rDef) {
            const vScale = generateScaleVariance({ category: "rock" }, Math.floor(rng.next() * 10000)).scale;
            addPlacement(rDef, new THREE.Vector3(rx, groundY + 0.3 * vScale[1], rz), yawQuat(rng.next() * Math.PI * 2), new THREE.Vector3(...vScale));
          }
        }
      }

      // Phase 7: Traps & Combination Puzzle Mechanics
      // 1. Combination Puzzle: 3 Rune Pillars / Dials guarding the Sanctum Door & Chest
      const sanctumDoor = pickCatPart("door") || pickCatPart("wall");
      const sanctumChest = pickCatPart("prop", "chest") || pickCatPart("prop");
      if (sanctumChest) {
        const chestScale = generateScaleVariance({ category: "prop", minScale: 0.95, maxScale: 1.10 }, Math.floor(rng.next() * 10000)).scale;
        addPlacement(sanctumChest, new THREE.Vector3(0, groundY + 0.5 * chestScale[1], 12.5), yawQuat(0), new THREE.Vector3(...chestScale));
      }

      const puzzleSymbols = ["Hawk", "Serpent", "Wolf", "Dragon"];
      const solution = [
        puzzleSymbols[Math.floor(rng.next() * puzzleSymbols.length)],
        puzzleSymbols[Math.floor(rng.next() * puzzleSymbols.length)],
        puzzleSymbols[Math.floor(rng.next() * puzzleSymbols.length)],
      ];

      // Entrypoint Inputs (3 rotating pillars / dials directly before the sanctum)
      const inputSlots: PuzzleInputSlot[] = [];
      const inputXs = [-2.5, 0.0, 2.5];
      const entryZ = 9.5;
      for (let i = 0; i < 3; i++) {
        const pillarModel = pickCatPart("puzzle", "rune_pillar") || pickCatPart("puzzle", "dial") || pickCatPart("puzzle") || pickCatPart("pillar");
        const xPos = inputXs[i];
        if (pillarModel) {
          addPlacement(pillarModel, new THREE.Vector3(xPos, groundY + 1.5, entryZ), yawQuat(0));
        }
        inputSlots.push({
          slotIndex: i,
          kind: "rune-pillar",
          partId: pillarModel?.id ?? `rune_pillar_${i}`,
          options: [...puzzleSymbols],
          currentState: puzzleSymbols[0],
          transform: {
            pos: [xPos, groundY + 1.5, entryZ],
            rot: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        });
      }

      // Plainly Displayed Clues placed through the Crypt Hall before the entrypoint (Z < 9.5)
      const cluePlacements: PuzzleCluePlacement[] = [
        {
          clueIndex: 0,
          partId: "SM_Prop_Wall_Banner_02",
          symbol: solution[0],
          clueType: "banner",
          description: `Ancient Hall Banner depicting the first seal: '${solution[0]}'`,
          transform: { pos: [-6.8, groundY + 2.0, -10.0], rot: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [1, 1, 1] },
          roomLocation: "West Entrance Aisle (Bay 1)",
        },
        {
          clueIndex: 1,
          partId: "SM_Env_Statue_01",
          symbol: solution[1],
          clueType: "statue",
          description: `Grave Keeper Statue inscription revealing the second seal: '${solution[1]}'`,
          transform: { pos: [6.8, groundY + 1.5, -2.5], rot: [0, -Math.SQRT1_2, 0, Math.SQRT1_2], scale: [1, 1, 1] },
          roomLocation: "East Sarcophagus Colonnade (Bay 2)",
        },
        {
          clueIndex: 2,
          partId: "SM_Prop_Wall_Banner_05",
          symbol: solution[2],
          clueType: "carving",
          description: `Sanctum Approach Wall Carving displaying the final seal: '${solution[2]}'`,
          transform: { pos: [-6.8, groundY + 2.0, 5.0], rot: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [1, 1, 1] },
          roomLocation: "West Nave Colonnade (Bay 3)",
        },
      ];

      for (const clue of cluePlacements) {
        const cluePart = pickCatPart("prop", "banner") || pickCatPart("prop") || pickCatPart("structure");
        if (cluePart) {
          addPlacement(cluePart, new THREE.Vector3(...clue.transform.pos), new THREE.Quaternion(...clue.transform.rot));
        }
      }

      generatedPuzzles.push({
        puzzleId: "crypt_sanctum_combination",
        name: "Trial of the Crypt Guardians",
        target: {
          type: "door",
          partId: sanctumDoor?.id ?? "SM_Env_Door_Bars_01",
          targetRef: "Sanctum_Iron_Gate_01",
          transform: { pos: [0, groundY + 2.0, 14.8], rot: [0, 1, 0, 0], scale: [1, 1, 1] },
          isLocked: true,
        },
        entrypoint: {
          inputs: inputSlots,
          promptTransform: { pos: [0, groundY + 1.0, 8.0], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        solution,
        clues: cluePlacements,
        possibleCombinationsCount: Math.pow(puzzleSymbols.length, 3), // 4^3 = 64
        onUnlock: {
          action: "open_door",
          animation: "door_bars_slide_open",
          grantsAccessTo: "High Crypt Inner Sanctum",
        },
      });

      // 2. Hidden Collision-Triggered Traps
      const trapSpots = [
        { id: "trap_spear_west_aisle", x: -5.0, z: 0.0, dmg: 35 },
        { id: "trap_spear_east_aisle", x: 5.0, z: 0.0, dmg: 35 },
        { id: "trap_spear_nave_chokepoint", x: 0.0, z: 6.0, dmg: 40 },
      ];

      for (const spot of trapSpots) {
        const trapPart = pickCatPart("trap", "spear") || pickCatPart("trap");
        if (trapPart) {
          addPlacement(trapPart, new THREE.Vector3(spot.x, groundY + 0.05, spot.z), yawQuat(0));
        }
        generatedTraps.push({
          trapId: spot.id,
          trapType: "floor-spear-grate",
          partId: trapPart?.id ?? "SM_Prop_Trap_Spears_Grate_01",
          assetRef: trapPart?.assetRef ?? "SM_Prop_Trap_Spears_Grate_01",
          transform: {
            pos: [spot.x, groundY + 0.05, spot.z],
            rot: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          triggerVolume: {
            shape: "box",
            boundsMin: [spot.x - 1.25, groundY, spot.z - 1.25],
            boundsMax: [spot.x + 1.25, groundY + 0.4, spot.z + 1.25],
            hidden: true,
          },
          onCollision: {
            animation: "spears_thrust_up",
            damage: spot.dmg,
            damageType: "physical",
            cooldownSec: 2.5,
            knockbackVec: [0, 2.5, 0],
          },
          state: "armed",
        });
      }

      // Alcove wall levers for secondary disarm
      const leverW = pickCatPart("puzzle", "lever") || pickCatPart("puzzle");
      const leverE = pickCatPart("puzzle", "lever") || pickCatPart("puzzle");
      if (leverW) addPlacement(leverW, new THREE.Vector3(-7.3, groundY + 1.8, 0), yawQuat(Math.PI / 2));
      if (leverE) addPlacement(leverE, new THREE.Vector3(7.3, groundY + 1.8, 0), yawQuat(-Math.PI / 2));
    } else if (archetype === "boss-arena") {
      // Expansive 5x5 bay Grand Arena (25m x 25m) with Double-Height Perimeter Walls
      const bays = 5;
      const cellM = 5.0;

      // Phase 1: Continuous Flagstone Floor
      for (let iz = 0; iz < bays; iz++) {
        for (let ix = 0; ix < bays; ix++) {
          const x = (ix - (bays - 1) / 2) * cellM;
          const z = (iz - (bays - 1) / 2) * cellM;
          const floorPart = pickCatPart("floor");
          if (floorPart) {
            addPlacement(floorPart, new THREE.Vector3(x, groundY, z), yawQuat(0));
          }
        }
      }

      // Phase 2: Double-Height Inward-facing Perimeter Walls
      const halfSpan = ((bays - 1) / 2) * cellM;
      const wallPerimeter = halfSpan + cellM / 2;

      // 4 sides: [normalX, normalZ, yawRad, isXAxis]
      const sides = [
        { nx: 0, nz: -1, yaw: 0, fixedCoord: -wallPerimeter, isZ: true }, // South wall (faces North)
        { nx: 0, nz: 1, yaw: Math.PI, fixedCoord: wallPerimeter, isZ: true }, // North wall (faces South)
        { nx: -1, nz: 0, yaw: -Math.PI / 2, fixedCoord: -wallPerimeter, isZ: false }, // West wall (faces East)
        { nx: 1, nz: 0, yaw: Math.PI / 2, fixedCoord: wallPerimeter, isZ: false }, // East wall (faces West)
      ];

      for (const side of sides) {
        for (let i = 0; i < bays; i++) {
          const step = (i - (bays - 1) / 2) * cellM;
          const x = side.isZ ? step : side.fixedCoord;
          const z = side.isZ ? side.fixedCoord : step;

          const isMainGate = side.isZ && side.fixedCoord === -wallPerimeter && i === 2;
          const def = isMainGate ? (pickCatPart("door") || pickCatPart("wall")) : pickCatPart("wall");

          if (def) {
            // Tier 1 (Ground level 0 - 4m)
            addPlacement(def, new THREE.Vector3(x, groundY + 2.0, z), yawQuat(side.yaw));

            // Tier 2 (Upper story 4m - 8m)
            const upperWall = pickCatPart("wall");
            if (upperWall) {
              addPlacement(upperWall, new THREE.Vector3(x, groundY + 6.0, z), yawQuat(side.yaw));
            }
          }
        }
      }

      // Phase 3: Colonnade pillars omitted in single-level arena (pillars only placed when connecting two floors)

      // Phase 4: Overhead Arch Vaults
      if (ceilingList.length > 0) {
        for (const cz of [-5.0, 0, 5.0]) {
          const ceilDef = pickCatPart("ceiling");
          if (ceilDef) {
            addPlacement(ceilDef, new THREE.Vector3(0, groundY + 4.2, cz), yawQuat(0));
          }
        }
      }

      // Phase 5: Central Arena Altar / Dais & Braziers
      const daisDef = pickCatPart("structure") || pickCatPart("prop");
      if (daisDef) {
        addPlacement(daisDef, new THREE.Vector3(0, groundY + 0.5, 4.0), yawQuat(Math.PI));
      }
      for (const bx of [-3.0, 3.0]) {
        const brazier = pickCatPart("prop");
        if (brazier) {
          addPlacement(brazier, new THREE.Vector3(bx, groundY + 0.4, 4.0), yawQuat(0));
        }
      }

      // Phase 6: Corner Rubble Heaps with Scale Variance
      for (const cx of [-10.5, 10.5]) {
        for (const cz of [-10.5, 10.5]) {
          const rub = pickCatPart("rubble") || pickCatPart("prop");
          if (rub) {
            const vScale = generateScaleVariance({ category: "rock" }, Math.floor(rng.next() * 10000)).scale;
            addPlacement(rub, new THREE.Vector3(cx, groundY + 0.3 * vScale[1], cz), yawQuat(rng.next() * Math.PI * 2), new THREE.Vector3(...vScale));
          }
        }
      }

      // Phase 7: Arena Saw Rail Traps & Dais Combination Puzzle
      // 1. Combination Puzzle: 3 Statue Dials flanking the Dais approach to unlock Dais Chest
      const daisChest = pickCatPart("prop", "chest") || pickCatPart("prop");
      if (daisChest) {
        const chestScale = generateScaleVariance({ category: "prop", minScale: 0.95, maxScale: 1.10 }, Math.floor(rng.next() * 10000)).scale;
        addPlacement(daisChest, new THREE.Vector3(0, groundY + 0.9 * chestScale[1], 6.5), yawQuat(Math.PI), new THREE.Vector3(...chestScale));
      }

      const arenaSymbols = ["Solar", "Lunar", "Eclipse"];
      const arenaSolution = [
        arenaSymbols[Math.floor(rng.next() * arenaSymbols.length)],
        arenaSymbols[Math.floor(rng.next() * arenaSymbols.length)],
        arenaSymbols[Math.floor(rng.next() * arenaSymbols.length)],
      ];

      const arenaInputSlots: PuzzleInputSlot[] = [];
      const arenaXs = [-4.0, 0.0, 4.0];
      for (let i = 0; i < 3; i++) {
        const dialPart = pickCatPart("puzzle", "lever") || pickCatPart("puzzle") || pickCatPart("pillar");
        const xPos = arenaXs[i];
        if (dialPart) {
          addPlacement(dialPart, new THREE.Vector3(xPos, groundY + 0.6, 1.5), yawQuat(Math.PI));
        }
        arenaInputSlots.push({
          slotIndex: i,
          kind: "dial",
          partId: dialPart?.id ?? `arena_dial_${i}`,
          options: [...arenaSymbols],
          currentState: arenaSymbols[0],
          transform: {
            pos: [xPos, groundY + 0.6, 1.5],
            rot: [0, 1, 0, 0],
            scale: [1, 1, 1],
          },
        });
      }

      // Plainly Displayed Clues placed around outer arena naves before reaching the dais
      const arenaClues: PuzzleCluePlacement[] = [
        {
          clueIndex: 0,
          partId: "SM_Prop_Wall_Banner_02",
          symbol: arenaSolution[0],
          clueType: "banner",
          description: `Southwest Arena Banner showing the first trial sign: '${arenaSolution[0]}'`,
          transform: { pos: [-9.0, groundY + 2.0, -8.0], rot: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [1, 1, 1] },
          roomLocation: "Southwest Arena Nave",
        },
        {
          clueIndex: 1,
          partId: "SM_Env_Statue_03",
          symbol: arenaSolution[1],
          clueType: "statue",
          description: `Southeast Warrior Statue tablet showing the second trial sign: '${arenaSolution[1]}'`,
          transform: { pos: [9.0, groundY + 1.5, -8.0], rot: [0, -Math.SQRT1_2, 0, Math.SQRT1_2], scale: [1, 1, 1] },
          roomLocation: "Southeast Arena Nave",
        },
        {
          clueIndex: 2,
          partId: "SM_Prop_Wall_Banner_06",
          symbol: arenaSolution[2],
          clueType: "banner",
          description: `Northwest Arena Wall Plaque showing the final trial sign: '${arenaSolution[2]}'`,
          transform: { pos: [-9.0, groundY + 2.0, 5.0], rot: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [1, 1, 1] },
          roomLocation: "Northwest Arena Perimeter",
        },
      ];

      for (const clue of arenaClues) {
        const cPart = pickCatPart("prop", "banner") || pickCatPart("prop") || pickCatPart("structure");
        if (cPart) {
          addPlacement(cPart, new THREE.Vector3(...clue.transform.pos), new THREE.Quaternion(...clue.transform.rot));
        }
      }

      generatedPuzzles.push({
        puzzleId: "arena_dais_combination",
        name: "Ritual of the Arena Champions",
        target: {
          type: "chest",
          partId: daisChest?.id ?? "SM_Prop_Chest_03",
          targetRef: "Champion_Treasure_Chest_01",
          transform: { pos: [0, groundY + 0.9, 6.5], rot: [0, 1, 0, 0], scale: [1, 1, 1] },
          isLocked: true,
        },
        entrypoint: {
          inputs: arenaInputSlots,
          promptTransform: { pos: [0, groundY + 0.6, 0.0], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        solution: arenaSolution,
        clues: arenaClues,
        possibleCombinationsCount: Math.pow(arenaSymbols.length, 3), // 3^3 = 27
        onUnlock: {
          action: "unlock_chest",
          animation: "chest_lid_open_spring",
          grantsAccessTo: "Champion's Relic Cache",
        },
      });

      // 2. Hidden Saw Rail Collision Traps along arena flanks
      for (const sx of [-8.0, 8.0]) {
        const sawTrap = pickCatPart("trap", "saw") || pickCatPart("trap");
        if (sawTrap) {
          addPlacement(sawTrap, new THREE.Vector3(sx, groundY + 0.2, -2.5), yawQuat(0));
        }
        generatedTraps.push({
          trapId: `arena_saw_rail_${sx > 0 ? "east" : "west"}`,
          trapType: "saw-rail",
          partId: sawTrap?.id ?? "SM_Prop_Trap_Saw_Rail_01",
          assetRef: sawTrap?.assetRef ?? "SM_Prop_Trap_Saw_Rail_01",
          transform: {
            pos: [sx, groundY + 0.2, -2.5],
            rot: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          triggerVolume: {
            shape: "box",
            boundsMin: [sx - 1.0, groundY, -5.0],
            boundsMax: [sx + 1.0, groundY + 0.6, 0.0],
            hidden: true,
          },
          onCollision: {
            animation: "saw_blade_spin_traverse",
            damage: 45,
            damageType: "bleed",
            cooldownSec: 3.0,
            knockbackVec: [sx > 0 ? -1.5 : 1.5, 0.5, 0],
          },
          state: "armed",
        });
      }
    } else if (archetype === "multi-level-descent") {
      // Second-level loft structure with structural pillars supporting the mezzanine from underneath
      // and triangular ramp / staircase bridging the elevation drop to the main hall
      const cellM = 5.0;
      const upperY = groundY + 3.5;
      const lowerY = groundY;

      // Phase 1: Continuous Ground Floor Plate (Walkable undercroft beneath the loft + main hall)
      for (const lz of [-12.5, -7.5, -2.5, 2.5, 7.5, 12.5]) {
        for (const lx of [-7.5, -2.5, 2.5, 7.5]) {
          const floorPart = pickCatPart("floor");
          if (floorPart) {
            addPlacement(floorPart, new THREE.Vector3(lx, lowerY, lz), yawQuat(0));
          }
        }
      }

      // Phase 2: Second-Level Loft Floor Deck (Elevated mezzanine at Y = 3.5m)
      for (const ux of [-5.0, 0, 5.0]) {
        for (const uz of [-12.5, -7.5]) {
          const floorPart = pickCatPart("floor");
          if (floorPart) {
            addPlacement(floorPart, new THREE.Vector3(ux, upperY, uz), yawQuat(0));
          }
        }
      }

      // Phase 3: Structural Under-Loft Support Pillars
      // Pillars stand on ground floor (Y = lowerY + 1.75m) and directly support the loft floor deck from underneath
      const supportPillarLocations = [
        [-5.0, -5.0], [5.0, -5.0],  // Front loft beam supports
        [-5.0, -10.0], [5.0, -10.0], // Mid loft structural supports
      ];
      for (const [px, pz] of supportPillarLocations) {
        const pillar = pickCatPart("pillar");
        if (pillar) {
          addPlacement(pillar, new THREE.Vector3(px, lowerY + 1.75, pz), yawQuat(0));
        }
      }

      // Phase 4: Triangular Ramp / Stepped Staircase bridging Ground to Loft
      // Ascends from main hall (z = 0.0, lowerY) up to loft mezzanine edge (z = -5.0, upperY)
      // Rotated yaw = 0 so the bottom step meets ground floor at z = 0.0 and top step meets loft floor at z = -5.0
      const stairDef = pickCatPart("stairs");
      if (stairDef) {
        addPlacement(stairDef, new THREE.Vector3(0, lowerY + 1.75, -2.5), yawQuat(0));
      }

      // Visual Affordance Markers: Twin illuminated torch braziers at foot of stairs
      // Guides player navigation and visual gaze directly to the vertical ascent entrypoint
      for (const bx of [-2.4, 2.4]) {
        const brazier = pickCatPart("prop", "torch") || pickCatPart("prop", "brazier") || pickCatPart("prop");
        if (brazier) {
          addPlacement(brazier, new THREE.Vector3(bx, lowerY + 0.6, 0.5), yawQuat(0));
        }
      }

      // Flanking staircase balustrades / handrails rising along stair flanks
      // Stairs run from Z = 0.0 (ground, lowerY) to Z = -5.0 (loft, upperY), width = 3.8m (tread edges X = ±1.9m)
      // Stair slope: rise = 3.5m, run = 5.0m, pitch angle theta = atan2(3.5, 5.0) = ~34.99 deg (~0.6109 rad)
      // Handrails flank both sides at X = ±2.0m, pitched along the incline so they ascend seamlessly from ground to loft
      const stairPitchRad = Math.atan2(upperY - lowerY, 5.0);
      const stairPitchQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(stairPitchRad, 0, 0, "YXZ"));
      for (const sx of [-2.0, 2.0]) {
        const stairRail = pickCatPart("railing", "angle") || pickCatPart("railing");
        if (stairRail) {
          // Midpoint at Z = -2.5, Y = lowerY + 1.75 + 0.45 (handrail center 0.45m above stair slope center, 0.9m height)
          addPlacement(stairRail, new THREE.Vector3(sx, lowerY + 2.2, -2.5), stairPitchQuat);
        }
      }

      // Phase 5: Loft Balcony Railings & Landing Torch Markers along open drop overlooking main hall
      // Loft opening for staircase is X in [-2.0, 2.0] at Z = -5.0; balcony edges span X in [-7.5, -2.0] and [2.0, 7.5]
      // Balcony railings centered at X = ±4.75m, Y = upperY + 0.45m to align flush with the stair handrail tops
      for (const rx of [-4.75, 4.75]) {
        const rail = pickCatPart("railing");
        if (rail) {
          addPlacement(rail, new THREE.Vector3(rx, upperY + 0.45, -5.0), yawQuat(0));
        }
      }
      for (const tx of [-2.4, 2.4]) {
        const topTorch = pickCatPart("prop", "torch") || pickCatPart("prop");
        if (topTorch) {
          addPlacement(topTorch, new THREE.Vector3(tx, upperY + 0.6, -5.0), yawQuat(0));
        }
      }

      // Phase 6: Complete Seamless Perimeter Walls (Fully enclosing lower and upper levels with zero gaps)
      // Tier 1 (Ground level, Y = lowerY + 2.0m): Encloses entire room perimeter continuously
      // South wall (Z = -15.0m, facing North into room)
      for (const lx of [-7.5, -2.5, 2.5, 7.5]) {
        const wall = pickCatPart("wall");
        if (wall) {
          addPlacement(wall, new THREE.Vector3(lx, lowerY + 2.0, -15.0), yawQuat(0));
        }
      }
      // North wall (Z = 15.0m, facing South into room)
      for (const lx of [-7.5, -2.5, 2.5, 7.5]) {
        const wall = pickCatPart("wall");
        if (wall) {
          addPlacement(wall, new THREE.Vector3(lx, lowerY + 2.0, 15.0), yawQuat(Math.PI));
        }
      }
      // West wall (X = -10.0m, facing East into room) across all 6 bays
      for (const lz of [-12.5, -7.5, -2.5, 2.5, 7.5, 12.5]) {
        const wall = pickCatPart("wall");
        if (wall) {
          addPlacement(wall, new THREE.Vector3(-10.0, lowerY + 2.0, lz), yawQuat(-Math.PI / 2));
        }
      }
      // East wall (X = 10.0m, facing West into room) across all 6 bays
      for (const lz of [-12.5, -7.5, -2.5, 2.5, 7.5, 12.5]) {
        const wall = pickCatPart("wall");
        if (wall) {
          addPlacement(wall, new THREE.Vector3(10.0, lowerY + 2.0, lz), yawQuat(Math.PI / 2));
        }
      }

      // Tier 2 (Upper level enclosure where levels switch and around the second-level loft):
      // Stacked upper walls directly on top of Tier 1 at Y = lowerY + 6.0m (spanning height 4m to 8m)
      // South upper wall (Z = -15.0m)
      for (const lx of [-7.5, -2.5, 2.5, 7.5]) {
        const wall = pickCatPart("wall");
        if (wall) {
          addPlacement(wall, new THREE.Vector3(lx, lowerY + 6.0, -15.0), yawQuat(0));
        }
      }
      // West & East upper walls along the loft and staircase transition zone (Z = -12.5, -7.5, -2.5)
      for (const lz of [-12.5, -7.5, -2.5]) {
        const wallW = pickCatPart("wall");
        const wallE = pickCatPart("wall");
        if (wallW) addPlacement(wallW, new THREE.Vector3(-10.0, lowerY + 6.0, lz), yawQuat(-Math.PI / 2));
        if (wallE) addPlacement(wallE, new THREE.Vector3(10.0, lowerY + 6.0, lz), yawQuat(Math.PI / 2));
      }

      // Phase 7: Altar & Rubble in Main Hall
      const shrine = pickCatPart("prop") || pickCatPart("structure");
      if (shrine) {
        addPlacement(shrine, new THREE.Vector3(0, lowerY + 0.6, 11.0), yawQuat(Math.PI));
      }
      for (const rz of [0.0, 10.0]) {
        const rub = pickCatPart("rubble");
        if (rub) {
          const vScale = generateScaleVariance({ category: "rock" }, Math.floor(rng.next() * 10000)).scale;
          addPlacement(rub, new THREE.Vector3(-8.5, lowerY + 0.3 * vScale[1], rz), yawQuat(rng.next() * Math.PI * 2), new THREE.Vector3(...vScale));
        }
      }

      // Phase 8: Traps & Loft Combination Puzzle Mechanism
      // 1. Combination Puzzle: 3 Balustrade Levers along upper loft to unlock Mezzanine Vault Door
      const vaultDoor = pickCatPart("door") || pickCatPart("wall");
      const vaultDoorPos: Vec3Tuple = [0, lowerY + 5.5, -15.0];
      if (vaultDoor) {
        addPlacement(vaultDoor, new THREE.Vector3(...vaultDoorPos), yawQuat(0));
      }

      const loftPositions = ["Up", "Mid", "Down"];
      const loftSolution = [
        loftPositions[Math.floor(rng.next() * loftPositions.length)],
        loftPositions[Math.floor(rng.next() * loftPositions.length)],
        loftPositions[Math.floor(rng.next() * loftPositions.length)],
      ];

      const loftInputSlots: PuzzleInputSlot[] = [];
      const loftXs = [-3.0, 0.0, 3.0];
      for (let i = 0; i < 3; i++) {
        const leverPart = pickCatPart("puzzle", "lever") || pickCatPart("puzzle");
        const xPos = loftXs[i];
        if (leverPart) {
          addPlacement(leverPart, new THREE.Vector3(xPos, upperY + 1.0, -6.5), yawQuat(Math.PI));
        }
        loftInputSlots.push({
          slotIndex: i,
          kind: "lever",
          partId: leverPart?.id ?? `loft_lever_${i}`,
          options: [...loftPositions],
          currentState: loftPositions[0],
          transform: {
            pos: [xPos, upperY + 1.0, -6.5],
            rot: [0, 1, 0, 0],
            scale: [1, 1, 1],
          },
        });
      }

      // Plainly Displayed Clues placed in the lower undercroft and ramp ascent before reaching the loft
      const loftClues: PuzzleCluePlacement[] = [
        {
          clueIndex: 0,
          partId: "SM_Prop_Bookcase_01",
          symbol: loftSolution[0],
          clueType: "book",
          description: `Undercroft Scholar's Ledger recording lever 1 position: '${loftSolution[0]}'`,
          transform: { pos: [-5.0, lowerY + 1.5, -10.0], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
          roomLocation: "Lower Undercroft West Pillar",
        },
        {
          clueIndex: 1,
          partId: "SM_Env_Statue_01",
          symbol: loftSolution[1],
          clueType: "statue",
          description: `Undercroft Shrine Inscription recording lever 2 position: '${loftSolution[1]}'`,
          transform: { pos: [5.0, lowerY + 1.5, -10.0], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
          roomLocation: "Lower Undercroft East Pillar",
        },
        {
          clueIndex: 2,
          partId: "SM_Prop_Wall_Banner_02",
          symbol: loftSolution[2],
          clueType: "banner",
          description: `Ramp Ascent Banner indicating lever 3 position: '${loftSolution[2]}'`,
          transform: { pos: [0.0, lowerY + 3.0, -2.5], rot: [0, -Math.SQRT1_2, 0, Math.SQRT1_2], scale: [1, 1, 1] },
          roomLocation: "Stepped Ramp Mid-Landing",
        },
      ];

      for (const clue of loftClues) {
        const cPart = pickCatPart("prop") || pickCatPart("structure");
        if (cPart) {
          addPlacement(cPart, new THREE.Vector3(...clue.transform.pos), new THREE.Quaternion(...clue.transform.rot));
        }
      }

      generatedPuzzles.push({
        puzzleId: "loft_vault_combination",
        name: "Mechanism of the High Mezzanine",
        target: {
          type: "door",
          partId: vaultDoor?.id ?? "SM_Env_Door_Bars_01",
          targetRef: "Upper_Vault_Reinforced_Door",
          transform: { pos: vaultDoorPos, rot: [0, 0, 0, 1], scale: [1, 1, 1] },
          isLocked: true,
        },
        entrypoint: {
          inputs: loftInputSlots,
          promptTransform: { pos: [0, upperY + 1.0, -7.5], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        solution: loftSolution,
        clues: loftClues,
        possibleCombinationsCount: Math.pow(loftPositions.length, 3), // 3^3 = 27
        onUnlock: {
          action: "open_door",
          animation: "door_bars_slide_open",
          grantsAccessTo: "High Mezzanine Reliquary Vault",
        },
      });

      // 2. Hidden Collision-Triggered Traps
      // Chokepoint floor spear trap embedded at base of descent ramp
      const rampTrap = pickCatPart("trap", "spear") || pickCatPart("trap");
      if (rampTrap) {
        addPlacement(rampTrap, new THREE.Vector3(0, lowerY + 0.05, 1.5), yawQuat(0));
      }
      generatedTraps.push({
        trapId: "ramp_foot_spear_chokepoint",
        trapType: "floor-spear-grate",
        partId: rampTrap?.id ?? "SM_Prop_Trap_Spears_Grate_01",
        assetRef: rampTrap?.assetRef ?? "SM_Prop_Trap_Spears_Grate_01",
        transform: {
          pos: [0, lowerY + 0.05, 1.5],
          rot: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        triggerVolume: {
          shape: "box",
          boundsMin: [-1.25, lowerY, 0.25],
          boundsMax: [1.25, lowerY + 0.4, 2.75],
          hidden: true,
        },
        onCollision: {
          animation: "spears_thrust_up",
          damage: 40,
          damageType: "physical",
          cooldownSec: 2.5,
          knockbackVec: [0, 2.0, 1.0],
        },
        state: "armed",
      });

      // Overhead swinging blade trap housing above the ramp
      const swingBlade = pickCatPart("trap", "swing") || pickCatPart("trap");
      if (swingBlade) {
        addPlacement(swingBlade, new THREE.Vector3(0, lowerY + 3.8, -2.5), yawQuat(0));
      }
      generatedTraps.push({
        trapId: "ramp_overhead_swinging_blade",
        trapType: "swinging-blade",
        partId: swingBlade?.id ?? "SM_Prop_Trap_Swing_Blade_01",
        assetRef: swingBlade?.assetRef ?? "SM_Prop_Trap_Swing_Blade_01",
        transform: {
          pos: [0, lowerY + 3.8, -2.5],
          rot: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        triggerVolume: {
          shape: "box",
          boundsMin: [-1.5, lowerY + 1.0, -3.75],
          boundsMax: [1.5, lowerY + 4.0, -1.25],
          hidden: true,
        },
        onCollision: {
          animation: "pendulum_swing_sweep",
          damage: 50,
          damageType: "crush",
          cooldownSec: 2.0,
          knockbackVec: [0, 0, 2.5],
        },
        state: "armed",
      });
    }
  }

  // 2. SOCKET EXPANSION FALLBACK / FREE DETAIL GROWTH
  // Pre-index adjacency rules by "aPart:aSocket"
  const rulesBySocket = new Map<string, AdjacencyRule[]>();
  for (const rule of ruleSet.adjacency) {
    const key = `${rule.aPart}:${rule.aSocket}`;
    if (!rulesBySocket.has(key)) rulesBySocket.set(key, []);
    rulesBySocket.get(key)!.push(rule);
  }

  // If no architectural placements were made (e.g. minimal dummy test rule set), initialize root
  if (placements.length === 0) {
    if (problem.pins && problem.pins.length > 0) {
      for (const pin of problem.pins) {
        const def = ruleSet.parts[pin.partId];
        if (def) {
          addPlacement(
            def,
            new THREE.Vector3(...pin.transform.pos),
            new THREE.Quaternion(...pin.transform.rot),
            new THREE.Vector3(...pin.transform.scale)
          );
        }
      }
    } else {
      const candidateParts = Object.values(ruleSet.parts);
      if (candidateParts.length === 0) {
        throw new Error("Cannot synthesize: RuleSet contains no parts");
      }
      const floorParts = candidateParts.filter((p) => p.category === "floor");
      const rootPart = (floorParts.length > 0 ? floorParts : candidateParts)[0];
      const centerPos = new THREE.Vector3()
        .addVectors(siteMin, siteMax)
        .multiplyScalar(0.5);
      centerPos.y = siteMin.y + rootPart.bounds.size[1] / 2;
      addPlacement(rootPart, centerPos, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    }
  }

  // Continue socket growth if under part budget
  let growthAttempts = 0;
  while (placements.length < maxParts && openSockets.length > 0 && growthAttempts < maxGrowthAttempts) {
    growthAttempts++;
    const socketIdx = rng.nextInt(0, Math.min(openSockets.length - 1, 8));
    const activeSocket = openSockets.splice(socketIdx, 1)[0];

    const matchingRules = rulesBySocket.get(`${activeSocket.partId}:${activeSocket.socketName}`) || [];
    if (matchingRules.length === 0) continue;

    for (let c = 0; c < Math.min(matchingRules.length, 3); c++) {
      const rule = rng.pickWeighted(matchingRules, (r) => r.frequency * (r.count || 1));
      if (!rule) break;

      const bPartDef = ruleSet.parts[rule.bPart];
      if (!bPartDef) continue;
      const bSocketDef = bPartDef.sockets.find((s) => s.name === rule.bSocket) || bPartDef.sockets[0];
      if (!bSocketDef) continue;

      const rot = new THREE.Quaternion();
      const targetNormal = activeSocket.worldNormal.clone().negate();
      const candidateLocalNormal = new THREE.Vector3(...bSocketDef.normal);

      const tLenXZ = Math.hypot(targetNormal.x, targetNormal.z);
      const cLenXZ = Math.hypot(candidateLocalNormal.x, candidateLocalNormal.z);

      if (tLenXZ > 0.1 && cLenXZ > 0.1) {
        const angTarget = Math.atan2(targetNormal.x, targetNormal.z);
        const angLocal = Math.atan2(candidateLocalNormal.x, candidateLocalNormal.z);
        rot.setFromAxisAngle(new THREE.Vector3(0, 1, 0), angTarget - angLocal);
      } else {
        rot.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0);
      }

      const localSocketOff = new THREE.Vector3(...bSocketDef.offset).applyQuaternion(rot);
      const candidatePos = activeSocket.worldPos.clone().sub(localSocketOff);

      const [sx, sy, sz] = bPartDef.bounds.size;
      const halfSize = new THREE.Vector3(sx / 2, sy / 2, sz / 2);

      // Floor grounding
      if (bPartDef.category === "floor") {
        candidatePos.y = siteMin.y + halfSize.y;
      }

      // Check site bounds
      if (
        candidatePos.x - halfSize.x < siteMin.x ||
        candidatePos.x + halfSize.x > siteMax.x ||
        candidatePos.z - halfSize.z < siteMin.z ||
        candidatePos.z + halfSize.z > siteMax.z
      ) {
        continue;
      }

      const candidateAABB: BoundingAABB = {
        min: new THREE.Vector3().subVectors(candidatePos, halfSize),
        max: new THREE.Vector3().addVectors(candidatePos, halfSize),
      };

      let collides = false;
      for (const placed of placedAABBs) {
        if (aabbIntersects(candidateAABB, placed, 0.15)) {
          collides = true;
          break;
        }
      }
      if (collides) continue;

      // Architectural rule: do not place stairs or pillars unless they connect two floors together
      if (bPartDef.category === "stairs" || bPartDef.category === "pillar") {
        const dummyPlacement: SynthesizedPlacement = {
          partId: bPartDef.id,
          assetRef: bPartDef.assetRef,
          category: bPartDef.category,
          size: [...bPartDef.bounds.size],
          transform: {
            pos: quantizeVec3(candidatePos),
            rot: quantizeQuat(rot),
            scale: [1, 1, 1],
          },
        };
        if (!isConnectingTwoFloors(dummyPlacement, placements, ruleSet)) {
          continue;
        }
      }

      addPlacement(bPartDef, candidatePos, rot, new THREE.Vector3(1, 1, 1), bSocketDef.name);
      break;
    }
  }

  // Post-synthesis structural verification:
  // Reject and prune any stairs or pillars that do not connect two floor levels together
  const validPlacements = placements.filter((p) => isConnectingTwoFloors(p, placements, ruleSet));
  if (validPlacements.length !== placements.length) {
    placements.splice(0, placements.length, ...validPlacements);
    for (const k of Object.keys(categoryCounts)) delete categoryCounts[k];
    for (const k of Object.keys(scaleTierCounts)) scaleTierCounts[k] = 0;
    for (const p of placements) {
      categoryCounts[p.category] = (categoryCounts[p.category] || 0) + 1;
      const partDef = ruleSet.parts[p.partId];
      const maxDimM = partDef
        ? Math.max(
            partDef.bounds.size[0] * (p.transform.scale?.[0] || 1),
            partDef.bounds.size[1] * (p.transform.scale?.[1] || 1),
            partDef.bounds.size[2] * (p.transform.scale?.[2] || 1)
          )
        : 2.0;
      const tier = classifyScaleTier(maxDimM);
      scaleTierCounts[tier] = (scaleTierCounts[tier] || 0) + 1;
    }
  }

  const elapsedMs = Date.now() - startTime;
  const report: SynthesisReport = {
    partsPlaced: placements.length,
    growthAttempts,
    unfilledSockets: openSockets.length,
    elapsedMs,
    ruleSetVersion: ruleSet.extractorVersion,
    categoryCounts,
  };

  let spatialPerception = analyzeSpatialPerception(
    siteMax.x - siteMin.x,
    siteMax.z - siteMin.z,
    siteMax.y - siteMin.y
  );
  if (archetype === "crypt-hall") {
    spatialPerception = analyzeSpatialPerception(15, 30, 4.5);
  } else if (archetype === "boss-arena") {
    spatialPerception = analyzeSpatialPerception(25, 25, 8.0);
  } else if (archetype === "multi-level-descent") {
    spatialPerception = analyzeSpatialPerception(20, 30, 7.5);
  }

  return {
    placements,
    report,
    puzzles: generatedPuzzles,
    traps: generatedTraps,
    measurement: {
      spatialPerception,
      scaleTierCounts,
      humanScaleBaseline: {
        referenceHeightM: HUMAN_REFERENCE_METRICS.height,
        eyeLevelM: HUMAN_REFERENCE_METRICS.eyeLevel,
        stepOverThresholdM: HUMAN_REFERENCE_METRICS.stepOverHeight,
        reachRadiusM: HUMAN_REFERENCE_METRICS.reachDistance,
      },
      interactivitySummary: {
        interactableCount: (categoryCounts["trap"] || 0) + (categoryCounts["puzzle"] || 0) + (categoryCounts["prop"] || 0),
        traversalObstacleCount: (categoryCounts["wall"] || 0) + (categoryCounts["railing"] || 0) + (categoryCounts["pillar"] || 0),
        stepOverCount: categoryCounts["rubble"] || 0,
      },
    },
  };
}
