#!/usr/bin/env node
/**
 * CLI for scene decomposition, grammar extraction, and continuous model synthesis.
 *
 * Decomposes Unity demo scenes into modular assemblies, extracts learned spatial
 * grammar rules, and runs continuous model synthesis.
 *
 * Implements MODEL-SYNTHESIS-MAP.md §6-§8.
 */

import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { decomposeScene, extractLearnedRuleSet } from "./extractor.js";
import { synthesizeAssembly } from "./synthesizer.js";
import type { SynthesisProblem } from "./types.js";

function installShims(): void {
  // Shims for Three.js FBXLoader in Node.js
  (THREE.TextureLoader.prototype as any).load = function load(): any {
    return new THREE.Texture();
  };
  const g = globalThis as { FileReader?: unknown };
  g.FileReader ??= class {
    result: ArrayBuffer | string | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob): void {
      void blob.arrayBuffer().then((r) => {
        this.result = r;
        this.onloadend?.();
      });
    }
  };
}

function loadFbx(filePath: string): THREE.Group {
  installShims();
  const buf = fs.readFileSync(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return new FBXLoader().parse(ab, `${path.dirname(filePath)}/`);
}

function findWorkspaceRoot(): string {
  let dir = process.cwd();
  while (dir && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "packages"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const root = findWorkspaceRoot();

  const getArg = (flag: string, fallback: string): string => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };

  const defaultScene = "C:\\Users\\user\\Downloads\\POLYGON_Dungeon_Pack_SourceFiles_v2\\SourceFiles\\POLYGON_Dungeons_Demo_Scene.fbx";
  const scenePath = getArg("--scene", defaultScene);
  const outAssembliesPath = getArg("--out-assemblies", path.join(root, "content", "synthesis", "dungeon-assemblies.json"));
  const outRulesPath = getArg("--out-rules", path.join(root, "content", "synthesis", "dungeon-rules.json"));
  const outSynthesizedPath = getArg("--out-synthesized", path.join(root, "content", "synthesis", "synthesized-room.json"));

  console.log(`[Synthesis CLI] Loading scene from: ${scenePath}`);
  if (!fs.existsSync(scenePath)) {
    console.error(`[Synthesis CLI] Scene file not found: ${scenePath}`);
    process.exit(1);
  }

  const t0 = Date.now();
  const scene = loadFbx(scenePath);
  console.log(`[Synthesis CLI] Loaded FBX scene (${scene.children.length} root children) in ${Date.now() - t0}ms`);

  console.log(`[Synthesis CLI] Decomposing scene into spatial assemblies...`);
  const t1 = Date.now();
  const assemblies = decomposeScene(scene, {
    family: "dungeon",
    sourceName: "POLYGON_Dungeons_Demo_Scene",
    license: "Synty Store EULA",
    scaleFactor: 0.01, // Convert cm to metres
    clusterRadius: 35.0, // 35m spatial clusters
  });
  console.log(`[Synthesis CLI] Created ${assemblies.length} assemblies in ${Date.now() - t1}ms`);

  console.log(`[Synthesis CLI] Extracting learned spatial adjacency grammar...`);
  const t2 = Date.now();
  const ruleSet = extractLearnedRuleSet(assemblies, {
    family: "dungeon",
    adjacencyThreshold: 5.5, // 5.5m distance threshold
  });
  console.log(
    `[Synthesis CLI] Extracted ${ruleSet.adjacency.length} adjacency rules across ${ruleSet.stats.uniqueParts} unique parts (${ruleSet.stats.totalPlacements} total placements) in ${Date.now() - t2}ms`
  );

  // Ensure content/synthesis output directory exists
  fs.mkdirSync(path.dirname(outAssembliesPath), { recursive: true });
  fs.mkdirSync(path.dirname(outRulesPath), { recursive: true });
  fs.mkdirSync(path.dirname(outSynthesizedPath), { recursive: true });

  fs.writeFileSync(outAssembliesPath, JSON.stringify(assemblies, null, 2), "utf-8");
  console.log(`[Synthesis CLI] Wrote assemblies to ${outAssembliesPath} (${(fs.statSync(outAssembliesPath).size / 1024).toFixed(1)} KB)`);

  fs.writeFileSync(outRulesPath, JSON.stringify(ruleSet, null, 2), "utf-8");
  console.log(`[Synthesis CLI] Wrote rule set to ${outRulesPath} (${(fs.statSync(outRulesPath).size / 1024).toFixed(1)} KB)`);

  console.log(`[Synthesis CLI] Running continuous model synthesis test for a novel dungeon chamber...`);
  const t3 = Date.now();
  const problem: SynthesisProblem = {
    ruleSet,
    seed: 4242,
    site: {
      bounds: {
        min: [-25, 0, -25],
        max: [25, 12, 25],
      },
    },
    budget: {
      maxParts: 120,
      maxGrowthAttempts: 3000,
    },
  };

  const output = synthesizeAssembly(problem);
  console.log(
    `[Synthesis CLI] Synthesized ${output.placements.length} parts in ${output.report.elapsedMs}ms (${output.report.growthAttempts} growth attempts, ${output.report.unfilledSockets} unfilled sockets)`
  );
  console.log(`[Synthesis CLI] Category distribution:`, output.report.categoryCounts);

  fs.writeFileSync(outSynthesizedPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`[Synthesis CLI] Wrote synthesized assembly to ${outSynthesizedPath} (${(fs.statSync(outSynthesizedPath).size / 1024).toFixed(1)} KB)`);
  console.log(`[Synthesis CLI] Done! Total execution time: ${Date.now() - t0}ms`);
}

if (process.argv[1] && (process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("cli.js"))) {
  void runCli();
}
