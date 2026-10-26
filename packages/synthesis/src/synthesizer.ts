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
  const addPlacement = (partDef: PartDef, pos: THREE.Vector3, rot: THREE.Quaternion, scale: THREE.Vector3): number => {
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

    // Register sockets into open queue
    for (const s of partDef.sockets) {
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

    // Pick a candidate rule weighted by frequency
    const rule = rng.pickWeighted(matchingRules, (r) => r.frequency * (r.count || 1));
    if (!rule) continue;

    const bPartDef = ruleSet.parts[rule.bPart];
    if (!bPartDef) continue;

    const bSocketDef = bPartDef.sockets.find((s) => s.name === rule.bSocket) || bPartDef.sockets[0];
    if (!bSocketDef) continue;

    // Calculate rotation to align bSocket normal opposite to activeSocket normal
    const targetNormal = activeSocket.worldNormal.clone().negate();
    const candidateLocalNormal = new THREE.Vector3(...bSocketDef.normal);

    // Compute relative rotation from candidate local normal to target normal
    const rot = new THREE.Quaternion().setFromUnitVectors(candidateLocalNormal, targetNormal);

    // If relative yaw was observed, apply slight yaw variation
    if (rule.transformStats?.relativeYawDeg) {
      const yawQuat = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        THREE.MathUtils.degToRad(rule.transformStats.relativeYawDeg)
      );
      rot.multiply(yawQuat);
    }

    // Candidate part origin position:
    // P_b = P_socket - Rot(bSocket.offset)
    const localSocketOff = new THREE.Vector3(...bSocketDef.offset).applyQuaternion(rot);
    const candidatePos = activeSocket.worldPos.clone().sub(localSocketOff);

    // Add mean offset adjustment from rule if present
    if (rule.transformStats?.meanOffset) {
      const [ox, oy, oz] = rule.transformStats.meanOffset;
      const offVec = new THREE.Vector3(ox, oy, oz).applyQuaternion(rot).multiplyScalar(0.05); // subtle micro-shift
      candidatePos.add(offVec);
    }

    // Ground clamping if provided
    if (problem.site.groundHeight) {
      const gh = problem.site.groundHeight(candidatePos.x, candidatePos.z);
      if (candidatePos.y < gh) {
        candidatePos.y = gh;
      }
    }

    // Check bounds against site
    const [sx, sy, sz] = bPartDef.bounds.size;
    const halfSize = new THREE.Vector3(sx / 2, sy / 2, sz / 2);
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
    addPlacement(bPartDef, candidatePos, rot, new THREE.Vector3(1, 1, 1));
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
