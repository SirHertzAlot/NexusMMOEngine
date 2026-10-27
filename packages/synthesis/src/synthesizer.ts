/**
 * Continuous Growth Model Synthesizer.
 *
 * Implements tileless procedural assembly synthesis using learned spatial
 * grammar and socket adjacency distributions.
 *
 * Implements specifications from MODEL-SYNTHESIS-MAP.md §3, §4, §7, §8.
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
  RoomBlueprint,
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

  const pickCatPart = (cat: string): PartDef | null => {
    const list = partsByCat[cat];
    if (!list || list.length === 0) return null;
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

      // Phase 3: Colonnade Columns along Nave Boundaries (x = -2.5, +2.5)
      if (pillarList.length > 0) {
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

      // Phase 6: Corner Rubble / Props
      for (const rx of [-6.0, 6.0]) {
        for (const rz of [-13.5, 13.5]) {
          const rDef = pickCatPart("rubble") || pickCatPart("prop");
          if (rDef) {
            addPlacement(rDef, new THREE.Vector3(rx, groundY + 0.3, rz), yawQuat(rng.next() * Math.PI * 2));
          }
        }
      }
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

      // Phase 3: Colonnade Pillars framing Central Arena
      if (pillarList.length > 0) {
        const pillarDist = 6.0;
        for (const px of [-pillarDist, pillarDist]) {
          for (const pz of [-pillarDist, 0, pillarDist]) {
            const pillarDef = pickCatPart("pillar");
            if (pillarDef) {
              addPlacement(pillarDef, new THREE.Vector3(px, groundY + 2.0, pz), yawQuat(0));
            }
          }
        }
      }

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

      // Phase 6: Corner Rubble Heaps
      for (const cx of [-10.5, 10.5]) {
        for (const cz of [-10.5, 10.5]) {
          const rub = pickCatPart("rubble") || pickCatPart("prop");
          if (rub) {
            addPlacement(rub, new THREE.Vector3(cx, groundY + 0.3, cz), yawQuat(rng.next() * Math.PI * 2));
          }
        }
      }
    } else if (archetype === "multi-level-descent") {
      // Split-level: Upper Mezzanine (3x2 at Y=3.5) connecting via Stairs to Lower Hall (4x4 at Y=0)
      const cellM = 5.0;
      const upperY = groundY + 3.5;
      const lowerY = groundY;

      // Phase 1: Upper Mezzanine Terrace (x in [-5, 5], z in [-12.5, -7.5])
      for (const ux of [-5, 0, 5]) {
        for (const uz of [-12.5, -7.5]) {
          const floorPart = pickCatPart("floor");
          if (floorPart) {
            addPlacement(floorPart, new THREE.Vector3(ux, upperY, uz), yawQuat(0));
          }
        }
      }

      // Phase 2: Central Stairway bridging Upper to Lower Level
      const stairDef = pickCatPart("stairs");
      if (stairDef) {
        // Stairs at center (x = 0), stepping down from z = -5.0 to z = 0.0
        addPlacement(stairDef, new THREE.Vector3(0, lowerY + 1.75, -4.5), yawQuat(0));
      }

      // Phase 3: Mezzanine Railings along open drop (z = -5.0, x = -5, +5)
      for (const rx of [-5.0, 5.0]) {
        const rail = pickCatPart("railing");
        if (rail) {
          addPlacement(rail, new THREE.Vector3(rx, upperY + 0.8, -5.0), yawQuat(0));
        }
      }

      // Phase 4: Lower Crypt Hall (x in [-7.5, 7.5], z in [0, 15])
      for (const lz of [0, 5.0, 10.0, 15.0]) {
        for (const lx of [-7.5, -2.5, 2.5, 7.5]) {
          const floorPart = pickCatPart("floor");
          if (floorPart) {
            addPlacement(floorPart, new THREE.Vector3(lx, lowerY, lz), yawQuat(0));
          }
        }
      }

      // Phase 5: Terrace Under-Balcony Support Pillars
      for (const px of [-5.0, 5.0]) {
        const pillar = pickCatPart("pillar");
        if (pillar) {
          addPlacement(pillar, new THREE.Vector3(px, lowerY + 1.75, -5.5), yawQuat(0));
        }
      }

      // Phase 6: Perimeter Walls enclosing upper and lower chambers
      // Upper back & side walls
      for (const ux of [-5, 0, 5]) {
        const wall = pickCatPart("wall");
        if (wall) {
          addPlacement(wall, new THREE.Vector3(ux, upperY + 2.0, -15.0), yawQuat(0)); // South wall
        }
      }
      for (const uz of [-12.5, -7.5]) {
        const wallW = pickCatPart("wall");
        const wallE = pickCatPart("wall");
        if (wallW) addPlacement(wallW, new THREE.Vector3(-7.5, upperY + 2.0, uz), yawQuat(-Math.PI / 2));
        if (wallE) addPlacement(wallE, new THREE.Vector3(7.5, upperY + 2.0, uz), yawQuat(Math.PI / 2));
      }

      // Lower back & side walls
      for (const lx of [-7.5, -2.5, 2.5, 7.5]) {
        const wall = pickCatPart("wall");
        if (wall) {
          addPlacement(wall, new THREE.Vector3(lx, lowerY + 2.0, 17.5), yawQuat(Math.PI)); // North wall
        }
      }
      for (const lz of [0, 5.0, 10.0, 15.0]) {
        const wallW = pickCatPart("wall");
        const wallE = pickCatPart("wall");
        if (wallW) addPlacement(wallW, new THREE.Vector3(-10.0, lowerY + 2.0, lz), yawQuat(-Math.PI / 2));
        if (wallE) addPlacement(wallE, new THREE.Vector3(10.0, lowerY + 2.0, lz), yawQuat(Math.PI / 2));
      }

      // Phase 7: Altar & Rubble in Lower Crypt
      const shrine = pickCatPart("prop") || pickCatPart("structure");
      if (shrine) {
        addPlacement(shrine, new THREE.Vector3(0, lowerY + 0.6, 14.0), yawQuat(Math.PI));
      }
      for (const rz of [2.0, 12.0]) {
        const rub = pickCatPart("rubble");
        if (rub) {
          addPlacement(rub, new THREE.Vector3(-8.5, lowerY + 0.3, rz), yawQuat(rng.next() * Math.PI * 2));
        }
      }
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
