/**
 * Continuous Growth Model Synthesizer.
 *
 * Implements tileless procedural assembly synthesis using learned spatial
 * grammar and socket adjacency distributions.
 *
 * Implements specifications from MODEL-SYNTHESIS-MAP.md §3, §4, §7.
 */

import * as THREE from "three";
import type {
  SynthesisProblem,
  SynthesisOutput,
  SynthesizedPlacement,
  SynthesisReport,
  TransformData,
  BoundsData,
  Vec3Tuple,
  QuatTuple,
  AdjacencyRule,
  PartDef,
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

/**
 * Continuous spatial growth synthesizer.
 *
 * Takes a SynthesisProblem and produces deterministic, quantized model placements
 * satisfying learned adjacency rules without fixed grid constraints.
 */
export function synthesizeAssembly(problem: SynthesisProblem): SynthesisOutput {
  const startTime = Date.now();
  const rng = new DeterministicRng(problem.seed);
  const ruleSet = problem.ruleSet;
  const maxParts = Math.max(1, problem.budget.maxParts);
  const maxGrowthAttempts = problem.budget.maxGrowthAttempts ?? maxParts * 25;
  const tolerance = 0.2; // 20cm interpenetration margin

  // Pre-index adjacency rules by "aPart:aSocket"
  const rulesBySocket = new Map<string, AdjacencyRule[]>();
  for (const rule of ruleSet.adjacency) {
    const key = `${rule.aPart}:${rule.aSocket}`;
    if (!rulesBySocket.has(key)) rulesBySocket.set(key, []);
    rulesBySocket.get(key)!.push(rule);
  }

  // Placed parts list
  const placements: SynthesizedPlacement[] = [];
  const placedAABBs: BoundingAABB[] = [];
  const openSockets: WorldSocket[] = [];
  const categoryCounts: Record<string, number> = {};

  const siteMin = new THREE.Vector3(...problem.site.bounds.min);
  const siteMax = new THREE.Vector3(...problem.site.bounds.max);

  // Helper to add a part to the world
  const addPlacement = (
    partDef: PartDef,
    pos: THREE.Vector3,
    rot: THREE.Quaternion,
    scale: THREE.Vector3,
    ignoreSocketName?: string
  ): number => {
    const partIdx = placements.length;
    const cat = partDef.category;
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;

    // Calculate world bounding box
    const [sx, sy, sz] = partDef.bounds.size;
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
    });

    // Register sockets into open queue (skipping connecting socket)
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

  // 1. Initialize with pins or choose root foundation part
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
    // Pick highest frequency floor or structure part
    const floorParts = Object.values(ruleSet.parts).filter((p) => p.category === "floor");
    const candidateParts = floorParts.length > 0 ? floorParts : Object.values(ruleSet.parts);
    if (candidateParts.length === 0) {
      throw new Error("Cannot synthesize: RuleSet contains no parts");
    }

    const rootPart = rng.pickWeighted(candidateParts, (p) => ruleSet.stats.partFrequencies[p.id] || 1) ?? candidateParts[0];

    const centerPos = new THREE.Vector3()
      .addVectors(siteMin, siteMax)
      .multiplyScalar(0.5);
    centerPos.y = siteMin.y + rootPart.bounds.size[1] / 2;

    addPlacement(rootPart, centerPos, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
  }

  // 2. Incremental spatial growth
  let growthAttempts = 0;

  while (placements.length < maxParts && openSockets.length > 0 && growthAttempts < maxGrowthAttempts) {
    growthAttempts++;

    // Pick socket with lowest candidate rule count (minimum entropy) or prioritize by depth
    const socketIdx = rng.nextInt(0, Math.min(openSockets.length - 1, 8));
    const activeSocket = openSockets.splice(socketIdx, 1)[0];

    const matchingRules = rulesBySocket.get(`${activeSocket.partId}:${activeSocket.socketName}`) || [];
    if (matchingRules.length === 0) {
      continue;
    }

    // Try up to 4 candidate rules for this active socket
    for (let c = 0; c < Math.min(matchingRules.length, 4); c++) {
      const rule = rng.pickWeighted(matchingRules, (r) => r.frequency * (r.count || 1));
      if (!rule) break;

      const bPartDef = ruleSet.parts[rule.bPart];
      if (!bPartDef) continue;

      const bSocketDef = bPartDef.sockets.find((s) => s.name === rule.bSocket) || bPartDef.sockets[0];
      if (!bSocketDef) continue;

      // Compute strictly upright rotation (zero roll, zero pitch)
      const rot = new THREE.Quaternion();
      const targetNormal = activeSocket.worldNormal.clone().negate();
      const candidateLocalNormal = new THREE.Vector3(...bSocketDef.normal);

      const tLenXZ = Math.hypot(targetNormal.x, targetNormal.z);
      const cLenXZ = Math.hypot(candidateLocalNormal.x, candidateLocalNormal.z);

      if (tLenXZ > 0.1 && cLenXZ > 0.1) {
        // Pure horizontal yaw alignment
        const angTarget = Math.atan2(targetNormal.x, targetNormal.z);
        const angLocal = Math.atan2(candidateLocalNormal.x, candidateLocalNormal.z);
        const yaw = angTarget - angLocal;
        rot.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      } else if (Math.abs(candidateLocalNormal.y) > 0.7) {
        // Vertical socket (e.g. wall base on floor surface, or ceiling mount on wall top)
        const snapYaw = rng.nextInt(0, 3) * (Math.PI / 2);
        rot.setFromAxisAngle(new THREE.Vector3(0, 1, 0), snapYaw);
      } else {
        rot.setFromUnitVectors(candidateLocalNormal, targetNormal);
      }

      // Candidate part origin position:
      // P_b = P_socket - Rot(bSocket.offset)
      const localSocketOff = new THREE.Vector3(...bSocketDef.offset).applyQuaternion(rot);
      const candidatePos = activeSocket.worldPos.clone().sub(localSocketOff);

      // Add mean offset adjustment from rule if present (pure horizontal)
      if (rule.transformStats?.meanOffset) {
        const [ox, , oz] = rule.transformStats.meanOffset;
        const offVec = new THREE.Vector3(ox, 0, oz).applyQuaternion(rot).multiplyScalar(0.02);
        candidatePos.add(offVec);
      }

      const [sx, sy, sz] = bPartDef.bounds.size;
      const halfSize = new THREE.Vector3(sx / 2, sy / 2, sz / 2);

      // 1. Floor Grounding Rule: Floors must sit on the ground level
      if (bPartDef.category === "floor") {
        const expectedFloorY = siteMin.y + halfSize.y;
        if (activeSocket.kind !== "stairs-top") {
          candidatePos.y = expectedFloorY;
        }
      }

      // 2. Wall Grounding Rule: Walls must sit on floors or directly on lower walls
      if (bPartDef.category === "wall" || bPartDef.category === "door" || bPartDef.category === "railing") {
        const wallBaseY = candidatePos.y - halfSize.y;
        const isGroundLevel = wallBaseY <= siteMin.y + 0.4;

        if (isGroundLevel) {
          // Snap base cleanly to ground
          candidatePos.y = siteMin.y + halfSize.y;

          // Must have a floor tile within proximity (room perimeter)
          let hasFloorNearby = false;
          for (const p of placements) {
            if (p.category === "floor") {
              const dx = p.transform.pos[0] - candidatePos.x;
              const dz = p.transform.pos[2] - candidatePos.z;
              if (Math.hypot(dx, dz) <= 4.0) {
                hasFloorNearby = true;
                break;
              }
            }
          }
          if (!hasFloorNearby && placements.length > 0) {
            continue; // Reject floating wall outside room bounds
          }
        } else {
          // Upper wall must sit directly on top of a lower wall
          let hasLowerWall = false;
          for (const p of placements) {
            if (p.category === "wall" || p.category === "door") {
              const dx = Math.abs(p.transform.pos[0] - candidatePos.x);
              const dz = Math.abs(p.transform.pos[2] - candidatePos.z);
              const lowerTopY = p.transform.pos[1] + 2.0;
              if (dx < 0.8 && dz < 0.8 && Math.abs(wallBaseY - lowerTopY) < 0.8) {
                hasLowerWall = true;
                break;
              }
            }
          }
          if (!hasLowerWall) {
            continue; // Reject floating wall in mid-air
          }
        }
      }

      // 3. Pillar Grounding Rule: Pillars must sit on a floor or lower pillar
      if (bPartDef.category === "pillar") {
        const pillarBaseY = candidatePos.y - halfSize.y;
        let supported = false;
        for (const p of placements) {
          if (p.category === "floor") {
            const dx = Math.abs(p.transform.pos[0] - candidatePos.x);
            const dz = Math.abs(p.transform.pos[2] - candidatePos.z);
            if (dx < 2.5 && dz < 2.5 && Math.abs(pillarBaseY - p.transform.pos[1]) < 0.5) {
              supported = true;
              break;
            }
          }
        }
        if (!supported && pillarBaseY > siteMin.y + 0.4) {
          continue; // Reject floating pillar
        }
      }

      // 4. Props & Rubble Grounding Rule: Must sit on a floor surface
      if (bPartDef.category === "prop" || bPartDef.category === "rubble") {
        let onFloor = false;
        for (const p of placements) {
          if (p.category === "floor") {
            const dx = Math.abs(p.transform.pos[0] - candidatePos.x);
            const dz = Math.abs(p.transform.pos[2] - candidatePos.z);
            if (dx < 2.5 && dz < 2.5) {
              candidatePos.y = p.transform.pos[1] + 0.1 + halfSize.y;
              onFloor = true;
              break;
            }
          }
        }
        if (!onFloor) {
          continue; // Reject floating prop
        }
      }
      const candidateAABB: BoundingAABB = {
        min: new THREE.Vector3().subVectors(candidatePos, halfSize),
        max: new THREE.Vector3().addVectors(candidatePos, halfSize),
      };

      if (
        candidateAABB.min.x < siteMin.x ||
        candidateAABB.max.x > siteMax.x ||
        candidateAABB.min.y < siteMin.y ||
        candidateAABB.max.y > siteMax.y ||
        candidateAABB.min.z < siteMin.z ||
        candidateAABB.max.z > siteMax.z
      ) {
        // Out of site bounds, reject
        continue;
      }

      // Check collision against placed parts
      let collides = false;
      for (const placed of placedAABBs) {
        if (aabbIntersects(candidateAABB, placed, tolerance)) {
          collides = true;
          break;
        }
      }

      if (collides) {
        continue;
      }

      // Successfully place part!
      addPlacement(bPartDef, candidatePos, rot, new THREE.Vector3(1, 1, 1), bSocketDef.name);
      break;
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

  return {
    placements,
    report,
  };
}
