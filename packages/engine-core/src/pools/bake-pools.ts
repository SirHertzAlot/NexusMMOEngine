/**
 * bake-pools: headless CLI & library helper that compiles world/rules/scene
 * spawn definitions into an L2-bounded `"MMOS"` v1 SharedArrayBuffer binary
 * pool (`<dir>/world-respawns.sab.bin`) and prints a concise ConstraintReport.
 *
 * Usage:
 *   node dist/src/pools/bake-pools.js --out <dir|file> [options]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCivicRules, type CivicRules } from "@mmo-engine/rules";
import { expandPrefabs, worldNodes, type SceneDoc } from "@mmo-engine/scene";
import { parseSpawnTableJSON, type SpawnTable } from "@mmo-engine/scatter";
import { DEFAULT_PREFABS_DIR, DEFAULT_SCENES_DIR, loadPrefabs, loadScenes } from "../scene-spawn.js";
import { catalogBounds, type ModelBounds } from "../procgen/prop-shape.js";
import { ART_CATALOG } from "../procgen/world-populator.js";
import { DEFAULT_RULES_DIR, loadGameRules } from "../rules/boot.js";
import { saveSpawnPoolToDisk, type SaveSpawnPoolResult } from "./spawn-pool-io.js";
import {
  compileSpawnPool,
  type BreakableCandidateInput,
  type ChestCandidateInput,
  type CompileSpawnPoolInput,
  type ConstraintReport,
  type CreatureAnchorInput,
  type ExclusionZone,
  type ModelBoundDef,
  type ResourceCandidateInput,
  type StaticObstacle,
  type WorldBounds2D,
} from "./spawn-pool-solver.js";
import type { SpawnPoolSoA } from "./spawn-pool-soa.js";

export const DEFAULT_POOL_FILENAME = "world-respawns.sab.bin";
export const DEFAULT_WORLD_BOUNDS: WorldBounds2D = {
  minX: -2048,
  maxX: 2048,
  minZ: -2048,
  maxZ: 2048,
};

export interface BakePoolsConfigFile {
  bounds?: WorldBounds2D;
  modelBounds?: Record<string, ModelBoundDef>;
  spawnTable?: unknown;
  resources?: ResourceCandidateInput[];
  chests?: ChestCandidateInput[];
  breakables?: BreakableCandidateInput[];
  creatureSpawns?: Array<CreatureAnchorInput & { kind: string }>;
  exclusionZones?: ExclusionZone[];
  settlementExclusions?: ExclusionZone[];
  staticObstacles?: StaticObstacle[];
  maxSlopeRad?: number;
  defaultClearanceM?: number;
  defaultRadiusM?: number;
  maxSlots?: number;
  maxMemoryBytes?: number;
}

export interface BakePoolsCliArgs {
  out: string;
  rulesDir?: string;
  civicFile?: string;
  configFile?: string;
  sceneSpec?: string;
  scenesDir?: string;
  bounds?: WorldBounds2D;
  maxSlots?: number;
  maxMemoryBytes?: number;
  clearanceM?: number;
  maxSlopeRad?: number;
  json: boolean;
}

export interface BakeWorldSpawnPoolResult {
  outFile: string;
  save: SaveSpawnPoolResult;
  pool: SpawnPoolSoA;
  report: ConstraintReport;
}

function parseBoundsFlag(raw: string): WorldBounds2D {
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`--bounds must be "minX,maxX,minZ,maxZ" (got "${raw}")`);
  }
  const [minX, maxX, minZ, maxZ] = parts as [number, number, number, number];
  if (minX > maxX || minZ > maxZ) {
    throw new Error(`--bounds requires minX <= maxX and minZ <= maxZ (got "${raw}")`);
  }
  return { minX, maxX, minZ, maxZ };
}

function parseNumFlag(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a finite number (got "${raw}")`);
  }
  return n;
}

/** Parse CLI arguments for `bake-pools`. */
export function parseBakePoolsArgs(argv: readonly string[]): BakePoolsCliArgs {
  let out = path.resolve(process.env.MMO_DATA_DIR ?? "./data");
  let rulesDir: string | undefined;
  let civicFile: string | undefined;
  let configFile: string | undefined;
  let sceneSpec: string | undefined;
  let scenesDir: string | undefined;
  let bounds: WorldBounds2D | undefined;
  let maxSlots: number | undefined;
  let maxMemoryBytes: number | undefined;
  let clearanceM: number | undefined;
  let maxSlopeRad: number | undefined;
  let json = false;

  const takeValue = (i: number, flagName: string, inline?: string): { value: string; nextIdx: number } => {
    if (inline !== undefined) return { value: inline, nextIdx: i };
    const next = argv[i + 1];
    if (next === undefined) {
      throw new Error(`${flagName} requires a value`);
    }
    return { value: next, nextIdx: i + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eqIdx = arg.indexOf("=");
    const flag = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    const inline = eqIdx === -1 ? undefined : arg.slice(eqIdx + 1);

    if (flag === "--out") {
      const res = takeValue(i, "--out", inline);
      out = res.value;
      i = res.nextIdx;
    } else if (flag === "--rules") {
      const res = takeValue(i, "--rules", inline);
      rulesDir = res.value;
      i = res.nextIdx;
    } else if (flag === "--civic") {
      const res = takeValue(i, "--civic", inline);
      civicFile = res.value;
      i = res.nextIdx;
    } else if (flag === "--config") {
      const res = takeValue(i, "--config", inline);
      configFile = res.value;
      i = res.nextIdx;
    } else if (flag === "--scene") {
      const res = takeValue(i, "--scene", inline);
      sceneSpec = res.value;
      i = res.nextIdx;
    } else if (flag === "--scenes-dir") {
      const res = takeValue(i, "--scenes-dir", inline);
      scenesDir = res.value;
      i = res.nextIdx;
    } else if (flag === "--bounds") {
      const res = takeValue(i, "--bounds", inline);
      bounds = parseBoundsFlag(res.value);
      i = res.nextIdx;
    } else if (flag === "--max-slots") {
      const res = takeValue(i, "--max-slots", inline);
      maxSlots = Math.trunc(parseNumFlag("--max-slots", res.value));
      i = res.nextIdx;
    } else if (flag === "--max-memory-bytes") {
      const res = takeValue(i, "--max-memory-bytes", inline);
      maxMemoryBytes = Math.trunc(parseNumFlag("--max-memory-bytes", res.value));
      i = res.nextIdx;
    } else if (flag === "--clearance") {
      const res = takeValue(i, "--clearance", inline);
      clearanceM = parseNumFlag("--clearance", res.value);
      i = res.nextIdx;
    } else if (flag === "--max-slope") {
      const res = takeValue(i, "--max-slope", inline);
      maxSlopeRad = parseNumFlag("--max-slope", res.value);
      i = res.nextIdx;
    } else if (flag === "--json") {
      json = true;
    }
  }

  return {
    out,
    rulesDir,
    civicFile,
    configFile,
    sceneSpec,
    scenesDir,
    bounds,
    maxSlots,
    maxMemoryBytes,
    clearanceM,
    maxSlopeRad,
    json,
  };
}

/** Resolve `--out <dir/file>` onto `<dir>/world-respawns.sab.bin` or exact `.bin` file path. */
export function resolveBakeOutPath(outArg: string): string {
  const resolved = path.resolve(outArg);
  if (resolved.toLowerCase().endsWith(".bin")) {
    return resolved;
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return resolved;
  }
  return path.join(resolved, DEFAULT_POOL_FILENAME);
}

function extractSceneCandidates(scenes: readonly SceneDoc[], prefabsDir: string): {
  resources: ResourceCandidateInput[];
  chests: ChestCandidateInput[];
  breakables: BreakableCandidateInput[];
  creatureSpawns: Array<CreatureAnchorInput & { kind: string }>;
  modelBounds: Record<string, ModelBoundDef>;
} {
  const resources: ResourceCandidateInput[] = [];
  const chests: ChestCandidateInput[] = [];
  const breakables: BreakableCandidateInput[] = [];
  const creatureSpawns: Array<CreatureAnchorInput & { kind: string }> = [];
  const modelBounds: Record<string, ModelBoundDef> = {};
  const prefabs = fs.existsSync(prefabsDir) ? loadPrefabs(prefabsDir) : {};

  for (const scene of scenes) {
    const expanded = Object.keys(prefabs).length > 0 ? expandPrefabs(scene, prefabs).doc : scene;
    for (const w of worldNodes(expanded)) {
      const { node } = w;
      const [x, , z] = w.position;
      const key = `${scene.name}/${node.id}`;
      const structure = node.components?.Structure;
      const asset = typeof structure?.asset === "string" && structure.asset.length > 0 ? structure.asset : undefined;
      if (structure) {
        const halfX = Number(structure.width ?? 1) * 0.5;
        const halfY = Number(structure.height ?? 1) * 0.5;
        const halfZ = Number(structure.depth ?? 1) * 0.5;
        const modelKey = asset ?? (typeof structure.kind === "string" ? `structure:${structure.kind}` : undefined);
        if (modelKey && Number.isFinite(halfX) && Number.isFinite(halfZ) && halfX > 0 && halfZ > 0) {
          modelBounds[modelKey] = { halfExtents: [halfX, Math.max(0.1, halfY), halfZ] };
        }
      }

      const res = node.components?.ResourceNode;
      if (res) {
        const material = typeof res.material === "string" ? res.material : "unknown";
        const skill = typeof res.skill === "string" ? res.skill.toLowerCase() : "";
        resources.push({
          key,
          material,
          modelId: asset ?? (typeof structure?.kind === "string" ? `structure:${structure.kind}` : material),
          x,
          z,
          maxStock: Number(res.stock ?? 1),
          regrowHours: Number(res.regrowHours ?? 0),
          habitat: skill === "fishing" ? "water" : "land",
        });
      }

      const chest = node.components?.Chest;
      if (chest) {
        chests.push({
          key,
          modelId: asset ?? "chest",
          x,
          z,
          refillSeconds: Number(chest.refillSeconds ?? 600),
        });
      }

      const brk = node.components?.Breakable;
      if (brk) {
        breakables.push({
          key,
          modelId: asset ?? (typeof structure?.kind === "string" ? `structure:${structure.kind}` : key),
          x,
          z,
          respawnSeconds: Number(brk.respawnSeconds ?? 0),
        });
      }

      const spawner = node.components?.Spawner;
      if (spawner && typeof spawner.creature === "string" && spawner.creature.length > 0) {
        creatureSpawns.push({
          key,
          kind: spawner.creature,
          x,
          z,
          ...(typeof spawner.respawnSeconds === "number" ? { respawnSeconds: spawner.respawnSeconds } : {}),
        });
      }
    }
  }

  return { resources, chests, breakables, creatureSpawns, modelBounds };
}

/** Compile default/configured rules & bounds and save atomically onto disk. */
export function bakeWorldSpawnPool(opts: BakePoolsCliArgs): BakeWorldSpawnPoolResult {
  const rulesDir = opts.rulesDir ? path.resolve(opts.rulesDir) : DEFAULT_RULES_DIR;
  const game = loadGameRules(rulesDir);

  const defaultCivicPath = path.join(rulesDir, "civic.json");
  const civicPath = opts.civicFile
    ? path.resolve(opts.civicFile)
    : fs.existsSync(defaultCivicPath)
      ? defaultCivicPath
      : undefined;
  const civicRules: CivicRules = loadCivicRules(civicPath);

  const config: BakePoolsConfigFile = opts.configFile
    ? (JSON.parse(fs.readFileSync(path.resolve(opts.configFile), "utf8")) as BakePoolsConfigFile)
    : {};

  let catalog: ModelBounds | undefined;
  if (fs.existsSync(ART_CATALOG)) {
    catalog = catalogBounds(ART_CATALOG);
  }

  const sceneData = opts.sceneSpec
    ? extractSceneCandidates(
        loadScenes(opts.scenesDir ? path.resolve(opts.scenesDir) : DEFAULT_SCENES_DIR, opts.sceneSpec),
        DEFAULT_PREFABS_DIR,
      )
    : undefined;

  const mergedModelBounds = new Map<string, ModelBoundDef>();
  if (sceneData) {
    for (const [k, v] of Object.entries(sceneData.modelBounds)) {
      mergedModelBounds.set(k, v);
    }
  }
  if (config.modelBounds) {
    for (const [k, v] of Object.entries(config.modelBounds)) {
      mergedModelBounds.set(k, v);
    }
  }

  const combinedModelBounds: CompileSpawnPoolInput["modelBounds"] = (id: string) => {
    const explicit = mergedModelBounds.get(id);
    if (explicit) {
      if (explicit.size) return explicit.size;
      if (explicit.halfExtents) {
        return [explicit.halfExtents[0] * 2, explicit.halfExtents[1] * 2, explicit.halfExtents[2] * 2];
      }
      if (explicit.radius !== undefined) {
        return [explicit.radius * 2, explicit.radius * 2, explicit.radius * 2];
      }
    }
    return catalog?.(id);
  };

  let spawnTable: SpawnTable | undefined;
  if (config.spawnTable !== undefined) {
    spawnTable = parseSpawnTableJSON(config.spawnTable);
  }

  const compileInput: CompileSpawnPoolInput = {
    bounds: opts.bounds ?? config.bounds ?? DEFAULT_WORLD_BOUNDS,
    groundHeightAt: () => 0,
    modelBounds: combinedModelBounds,
    spawnTable,
    creatures: game.rules.creatures.creatures,
    gatheringRules: game.rules.gathering,
    civicRules,
    resources: [...(sceneData?.resources ?? []), ...(config.resources ?? [])],
    chests: [...(sceneData?.chests ?? []), ...(config.chests ?? [])],
    breakables: [...(sceneData?.breakables ?? []), ...(config.breakables ?? [])],
    creatureSpawns: [...(sceneData?.creatureSpawns ?? []), ...(config.creatureSpawns ?? [])],
    exclusionZones: config.exclusionZones,
    settlementExclusions: config.settlementExclusions,
    staticObstacles: config.staticObstacles,
    maxSlopeRad: opts.maxSlopeRad ?? config.maxSlopeRad,
    defaultClearanceM: opts.clearanceM ?? config.defaultClearanceM,
    defaultRadiusM: config.defaultRadiusM,
    maxSlots: opts.maxSlots ?? config.maxSlots,
    maxMemoryBytes: opts.maxMemoryBytes ?? config.maxMemoryBytes,
  };

  const { pool, report } = compileSpawnPool(compileInput);
  const outFile = resolveBakeOutPath(opts.out);
  const save = saveSpawnPoolToDisk(outFile, pool);

  return { outFile, save, pool, report };
}

/** Format a concise single/multi-line ConstraintReport summary (zero raw console calls). */
export function formatConstraintReport(res: BakeWorldSpawnPoolResult): string {
  const { report, save, outFile } = res;
  const b = report.breakdown;
  return [
    `[bake-pools] wrote ${outFile} (${save.bytesWritten} B)`,
    `[bake-pools] accepted=${report.accepted}/${report.totalCandidates} rejected=${report.rejected}` +
      ` (outOfBounds=${b.outOfBounds} exclusion=${b.exclusionZone} water=${b.waterHabitat}` +
      ` slope=${b.slopeTooSteep} overlap=${b.modelOverlap} cap=${b.capacityCapped} dup=${b.duplicateKey})`,
    `[bake-pools] sabBytes=${report.sabBytes} utilizationPct=${report.utilizationPct.toFixed(2)}%` +
      ` modelRadiiResolved=${report.modelRadiiResolved}` +
      ` kinds={creature=${report.byKind.creature}, resource=${report.byKind.resourceNode},` +
      ` civicVein=${report.byKind.civicVein}, chest=${report.byKind.chest},` +
      ` breakable=${report.byKind.breakableProp}}`,
  ].join("\n") + "\n";
}

/** Execute CLI with explicit argv and output stream (defaults to `process.stdout.write`). */
export function runBakePoolsCli(
  argv: readonly string[] = process.argv.slice(2),
  writeOut: (chunk: string) => void = (chunk) => {
    process.stdout.write(chunk);
  },
): BakeWorldSpawnPoolResult {
  const parsed = parseBakePoolsArgs(argv);
  const res = bakeWorldSpawnPool(parsed);
  if (parsed.json) {
    writeOut(JSON.stringify({ outFile: res.outFile, bytesWritten: res.save.bytesWritten, report: res.report }) + "\n");
  } else {
    writeOut(formatConstraintReport(res));
  }
  return res;
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    runBakePoolsCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[bake-pools] FAILED: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
