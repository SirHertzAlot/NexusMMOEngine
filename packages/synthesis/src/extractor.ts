/**
 * Scene Decomposer and Rule Extractor.
 *
 * Decomposes a 3D scene (Unity demo scene / FBX / GLTF) into structured
 * ExampleAssemblies and extracts a LearnedRuleSet capturing the architectural
 * grammar, adjacency frequencies, and relative spatial transform distributions.
 *
 * Implements MODEL-SYNTHESIS-MAP.md §6-§7.
 */

import * as THREE from "three";
import type {
  ExampleAssembly,
  LearnedRuleSet,
  PartDef,
  PlacedPartInstance,
  SocketDef,
  AdjacencyRule,
  BoundsData,
  Vec3Tuple,
  QuatTuple,
  TransformData,
} from "./types.js";

export interface ExtractorOptions {
  family?: string;
  sourceName?: string;
  license?: string;
  /** Scale factor to convert source units to metres (default 0.01 for Maya/FBX cm). */
  scaleFactor?: number;
  /** Maximum distance to consider two parts adjacent in metres (default 5.5m). */
  adjacencyThreshold?: number;
  /** Radius for spatial room/cluster segmentation in metres (default 30m). */
  clusterRadius?: number;
}

/** Categorize a part name into an architectural role. */
export function categorizePart(partId: string): string {
  const p = partId.toLowerCase();
  if (p.includes("tile") || p.includes("floor")) return "floor";
  if (p.includes("wall") || p.includes("basement")) return "wall";
  if (p.includes("ceiling") || p.includes("roof")) return "ceiling";
  if (p.includes("pillar") || p.includes("column")) return "pillar";
  if (p.includes("stair")) return "stairs";
  if (p.includes("door") || p.includes("gate")) return "door";
  if (p.includes("railing") || p.includes("fence")) return "railing";
  if (p.includes("prop") || p.includes("chest") || p.includes("barrel") || p.includes("crate") || p.includes("candle") || p.includes("torch")) return "prop";
  if (p.includes("rubble") || p.includes("pebble")) return "rubble";
  if (p.includes("rock") || p.includes("cave") || p.includes("stalactite") || p.includes("stalagmite")) return "rock";
  if (p.includes("grass") || p.includes("mushroom") || p.includes("plant")) return "nature";
  return "structure";
}

/** Generate continuous sockets for a part based on its category and bounding box. */
export function generatePartSockets(partId: string, category: string, bounds: BoundsData): SocketDef[] {
  const [sx, sy, sz] = bounds.size;
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const sockets: SocketDef[] = [];

  if (category === "floor") {
    sockets.push({ name: "edge_px", kind: "floor-edge", offset: [hx, 0, 0], normal: [1, 0, 0] });
    sockets.push({ name: "edge_nx", kind: "floor-edge", offset: [-hx, 0, 0], normal: [-1, 0, 0] });
    sockets.push({ name: "edge_pz", kind: "floor-edge", offset: [0, 0, hz], normal: [0, 0, 1] });
    sockets.push({ name: "edge_nz", kind: "floor-edge", offset: [0, 0, -hz], normal: [0, 0, -1] });
    sockets.push({ name: "top", kind: "surface-mount", offset: [0, hy, 0], normal: [0, 1, 0] });
  } else if (category === "wall") {
    sockets.push({ name: "edge_left", kind: "wall-edge", offset: [-hx, 0, 0], normal: [-1, 0, 0] });
    sockets.push({ name: "edge_right", kind: "wall-edge", offset: [hx, 0, 0], normal: [1, 0, 0] });
    sockets.push({ name: "edge_px", kind: "wall-edge", offset: [hx, 0, 0], normal: [1, 0, 0] });
    sockets.push({ name: "edge_nx", kind: "wall-edge", offset: [-hx, 0, 0], normal: [-1, 0, 0] });
    sockets.push({ name: "bottom", kind: "wall-base", offset: [0, -hy, 0], normal: [0, -1, 0] });
    sockets.push({ name: "top", kind: "wall-top", offset: [0, hy, 0], normal: [0, 1, 0] });
    sockets.push({ name: "front", kind: "wall-face", offset: [0, 0, hz], normal: [0, 0, 1] });
  } else if (category === "pillar") {
    sockets.push({ name: "bottom", kind: "pillar-base", offset: [0, -hy, 0], normal: [0, -1, 0] });
    sockets.push({ name: "top", kind: "pillar-cap", offset: [0, hy, 0], normal: [0, 1, 0] });
    sockets.push({ name: "side_px", kind: "pillar-side", offset: [hx, 0, 0], normal: [1, 0, 0] });
    sockets.push({ name: "side_nx", kind: "pillar-side", offset: [-hx, 0, 0], normal: [-1, 0, 0] });
    sockets.push({ name: "side_pz", kind: "pillar-side", offset: [0, 0, hz], normal: [0, 0, 1] });
    sockets.push({ name: "side_nz", kind: "pillar-side", offset: [0, 0, -hz], normal: [0, 0, -1] });
  } else if (category === "ceiling") {
    sockets.push({ name: "edge_px", kind: "ceiling-edge", offset: [hx, 0, 0], normal: [1, 0, 0] });
    sockets.push({ name: "edge_nx", kind: "ceiling-edge", offset: [-hx, 0, 0], normal: [-1, 0, 0] });
    sockets.push({ name: "edge_pz", kind: "ceiling-edge", offset: [0, 0, hz], normal: [0, 0, 1] });
    sockets.push({ name: "edge_nz", kind: "ceiling-edge", offset: [0, 0, -hz], normal: [0, 0, -1] });
    sockets.push({ name: "bottom", kind: "ceiling-mount", offset: [0, -hy, 0], normal: [0, -1, 0] });
  } else {
    // Default prop / structure mount sockets
    sockets.push({ name: "mount_bottom", kind: "surface-contact", offset: [0, -hy, 0], normal: [0, -1, 0] });
    sockets.push({ name: "mount_top", kind: "surface-contact", offset: [0, hy, 0], normal: [0, 1, 0] });
  }

  return sockets;
}

/** Decompose an FBX or Three.js scene graph into ExampleAssemblies. */
export function decomposeScene(scene: THREE.Object3D, opts: ExtractorOptions = {}): ExampleAssembly[] {
  const scale = opts.scaleFactor ?? 0.01;
  const clusterRad = opts.clusterRadius ?? 35.0;
  const family = opts.family ?? "dungeon";
  const source = opts.sourceName ?? "Unity_Demo_Scene";
  const license = opts.license ?? "Synty Store EULA";

  const allParts: PlacedPartInstance[] = [];

  // Traverse and collect parts with normalized transforms
  for (const obj of scene.children) {
    if (!obj.name) continue;
    const baseId = obj.name.replace(/_\d+$/, "");
    const category = categorizePart(baseId);

    // Compute bounds in world space
    const box = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());

    // Normalize coordinates (convert cm to metres)
    const px = obj.position.x * scale;
    const py = obj.position.y * scale;
    const pz = obj.position.z * scale;

    const q = obj.quaternion;
    const s = obj.scale;

    allParts.push({
      partId: baseId,
      assetRef: `models/glb/dungeon-pack/${category}/${baseId}.glb`,
      category,
      transform: {
        pos: [Math.round(px * 1000) / 1000, Math.round(py * 1000) / 1000, Math.round(pz * 1000) / 1000],
        rot: [Math.round(q.x * 10000) / 10000, Math.round(q.y * 10000) / 10000, Math.round(q.z * 10000) / 10000, Math.round(q.w * 10000) / 10000],
        scale: [Math.round(s.x * 100) / 100, Math.round(s.y * 100) / 100, Math.round(s.z * 100) / 100],
      },
    });
  }

  if (allParts.length === 0) return [];

  // Spatial grid clustering to partition demo scene into functional room assemblies
  const clusterMap = new Map<string, PlacedPartInstance[]>();
  for (const part of allParts) {
    const [x, , z] = part.transform.pos;
    const cx = Math.floor(x / clusterRad);
    const cz = Math.floor(z / clusterRad);
    const key = `${cx}_${cz}`;
    if (!clusterMap.has(key)) clusterMap.set(key, []);
    clusterMap.get(key)!.push(part);
  }

  const assemblies: ExampleAssembly[] = [];
  let clusterIdx = 1;

  for (const [key, clusterParts] of clusterMap.entries()) {
    if (clusterParts.length < 5) continue; // Skip tiny straggler clusters

    // Compute cluster bounding box
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const p of clusterParts) {
      const [x, y, z] = p.transform.pos;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    assemblies.push({
      id: `${family}_assembly_${clusterIdx++}_${key}`,
      family,
      source,
      license,
      parts: clusterParts,
      bounds: {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
        size: [maxX - minX, maxY - minY, maxZ - minZ],
      },
    });
  }

  return assemblies;
}

/** Extract a LearnedRuleSet from decomposed example assemblies. */
export function extractLearnedRuleSet(
  assemblies: ExampleAssembly[],
  opts: ExtractorOptions = {}
): LearnedRuleSet {
  const family = opts.family ?? "dungeon";
  const adjThreshold = opts.adjacencyThreshold ?? 5.5;

  const partMap: Record<string, PartDef> = {};
  const partFrequencies: Record<string, number> = {};
  const categoryDistribution: Record<string, number> = {};
  const pairStats = new Map<string, { count: number; offsets: Vec3Tuple[]; yawDeltas: number[] }>();
  const connectedSockets = new Set<string>();

  let totalPlacements = 0;

  // 1. Catalog parts and compute bounds & sockets
  for (const asm of assemblies) {
    for (const p of asm.parts) {
      totalPlacements++;
      partFrequencies[p.partId] = (partFrequencies[p.partId] || 0) + 1;
      const cat = p.category || categorizePart(p.partId);
      categoryDistribution[cat] = (categoryDistribution[cat] || 0) + 1;

      if (!partMap[p.partId]) {
        // Approximate standard part size in metres by category
        let defaultSize: Vec3Tuple = [2.5, 2.5, 2.5];
        if (cat === "floor") defaultSize = [5.0, 0.2, 5.0];
        else if (cat === "wall") defaultSize = [5.0, 4.0, 0.5];
        else if (cat === "pillar") defaultSize = [1.5, 4.0, 1.5];
        else if (cat === "ceiling") defaultSize = [5.0, 0.5, 5.0];
        else if (cat === "stairs") defaultSize = [2.5, 3.0, 5.0];
        else if (cat === "door") defaultSize = [2.5, 4.0, 0.5];
        else if (cat === "prop" || cat === "rubble") defaultSize = [1.0, 1.0, 1.0];

        const bounds: BoundsData = {
          min: [-defaultSize[0] / 2, -defaultSize[1] / 2, -defaultSize[2] / 2],
          max: [defaultSize[0] / 2, defaultSize[1] / 2, defaultSize[2] / 2],
          size: defaultSize,
        };

        partMap[p.partId] = {
          id: p.partId,
          assetRef: p.assetRef,
          category: cat,
          bounds,
          sockets: generatePartSockets(p.partId, cat, bounds),
        };
      }
    }
  }

  // 2. Discover spatial adjacencies between neighbouring parts within each assembly
  for (const asm of assemblies) {
    const parts = asm.parts;
    const n = parts.length;

    for (let i = 0; i < n; i++) {
      const a = parts[i];
      const [ax, ay, az] = a.transform.pos;

      for (let j = i + 1; j < n; j++) {
        const b = parts[j];
        const [bx, by, bz] = b.transform.pos;
        const dx = bx - ax;
        const dy = by - ay;
        const dz = bz - az;
        const dist = Math.hypot(dx, dy, dz);

        if (dist <= adjThreshold) {
          const dirX = dx / (dist || 1);
          const dirY = dy / (dist || 1);
          const dirZ = dz / (dist || 1);

          const aDef = partMap[a.partId];
          const bDef = partMap[b.partId];
          if (!aDef || !bDef) continue;

          // Find socket on A pointing towards B
          let bestASock = aDef.sockets[0];
          let bestADot = -Infinity;
          for (const s of aDef.sockets) {
            const dot = s.normal[0] * dirX + s.normal[1] * dirY + s.normal[2] * dirZ;
            if (dot > bestADot) {
              bestADot = dot;
              bestASock = s;
            }
          }

          // Find socket on B pointing towards A
          let bestBSock = bDef.sockets[0];
          let bestBDot = -Infinity;
          for (const s of bDef.sockets) {
            const dot = s.normal[0] * -dirX + s.normal[1] * -dirY + s.normal[2] * -dirZ;
            if (dot > bestBDot) {
              bestBDot = dot;
              bestBSock = s;
            }
          }

          // Forward rule (A -> B)
          const pairKeyAB = `${a.partId}:${bestASock.name}-->${b.partId}:${bestBSock.name}`;
          connectedSockets.add(`${a.partId}:${bestASock.name}`);
          connectedSockets.add(`${b.partId}:${bestBSock.name}`);
          if (!pairStats.has(pairKeyAB)) {
            pairStats.set(pairKeyAB, { count: 0, offsets: [], yawDeltas: [] });
          }
          const statAB = pairStats.get(pairKeyAB)!;
          statAB.count++;
          statAB.offsets.push([dx, dy, dz]);
          statAB.yawDeltas.push(0);

          // Reverse symmetric rule (B -> A)
          const pairKeyBA = `${b.partId}:${bestBSock.name}-->${a.partId}:${bestASock.name}`;
          if (!pairStats.has(pairKeyBA)) {
            pairStats.set(pairKeyBA, { count: 0, offsets: [], yawDeltas: [] });
          }
          const statBA = pairStats.get(pairKeyBA)!;
          statBA.count++;
          statBA.offsets.push([-dx, -dy, -dz]);
          statBA.yawDeltas.push(0);
        }
      }
    }
  }

  // 3. Compile AdjacencyRules with mean and spread stats
  const adjacency: AdjacencyRule[] = [];
  let totalPairs = 0;

  for (const [key, stat] of pairStats.entries()) {
    totalPairs += stat.count;
    const [aStr, bStr] = key.split("-->");
    const [aPart, aSocket] = aStr.split(":");
    const [bPart, bSocket] = bStr.split(":");

    // Compute mean offset
    let mx = 0, my = 0, mz = 0;
    for (const off of stat.offsets) {
      mx += off[0];
      my += off[1];
      mz += off[2];
    }
    mx /= stat.count;
    my /= stat.count;
    mz /= stat.count;

    // Compute spread offset (variance / std-dev)
    let vx = 0, vy = 0, vz = 0;
    for (const off of stat.offsets) {
      vx += (off[0] - mx) ** 2;
      vy += (off[1] - my) ** 2;
      vz += (off[2] - mz) ** 2;
    }
    const sx = Math.sqrt(vx / stat.count);
    const sy = Math.sqrt(vy / stat.count);
    const sz = Math.sqrt(vz / stat.count);

    adjacency.push({
      aPart,
      aSocket,
      bPart,
      bSocket,
      count: stat.count,
      frequency: stat.count / Math.max(1, partFrequencies[aPart] || 1),
      transformStats: {
        meanOffset: [Math.round(mx * 1000) / 1000, Math.round(my * 1000) / 1000, Math.round(mz * 1000) / 1000],
        spreadOffset: [Math.round(sx * 1000) / 1000, Math.round(sy * 1000) / 1000, Math.round(sz * 1000) / 1000],
        relativeYawDeg: 0,
      },
    });
  }

  // 4. Identify terminal sockets (unconnected in observations)
  const terminals: Array<{ partId: string; socket: string }> = [];
  for (const pId of Object.keys(partMap)) {
    for (const sock of partMap[pId].sockets) {
      if (!connectedSockets.has(`${pId}:${sock.name}`)) {
        terminals.push({ partId: pId, socket: sock.name });
      }
    }
  }

  return {
    family,
    extractorVersion: "1.0.0",
    sourceAssemblies: assemblies.map((a) => a.id),
    parts: partMap,
    adjacency,
    terminals,
    stats: {
      totalPlacements,
      uniqueParts: Object.keys(partMap).length,
      totalAdjacencyPairs: totalPairs,
      categoryDistribution,
      partFrequencies,
    },
  };
}
