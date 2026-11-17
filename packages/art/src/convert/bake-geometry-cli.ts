#!/usr/bin/env node
/**
 * CLI for Baked Asset Store B1 geometry baking (`BAKED-ASSET-STORE-SPEC.md §5 B1`):
 *
 *   npm run bake:geometry -w @mmo-engine/art -- --kit fantasy-kingdom --out <dir> [--target own-game]
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { bakeKitGeometry } from "../baked-geometry-bake.js";
import type { BakeTarget } from "../baked-store.js";

function parseArgs(argv: readonly string[]): {
  kit: string;
  assetsRoot: string;
  outDir: string;
  target: BakeTarget;
  creditsPath?: string;
} {
  let kit = "fantasy-kingdom";
  let assetsRoot = "assets";
  let outDir = "baked-out";
  let target: BakeTarget = "own-game";
  let creditsPath: string | undefined = "content/credits.json";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--kit" && argv[i + 1]) kit = argv[++i];
    else if (a === "--assets" && argv[i + 1]) assetsRoot = argv[++i];
    else if (a === "--out" && argv[i + 1]) outDir = argv[++i];
    else if (a === "--target" && argv[i + 1]) {
      const t = argv[++i];
      if (t !== "own-game" && t !== "shipped-prototype-pack") {
        throw new Error(`Invalid --target "${t}"`);
      }
      target = t;
    } else if (a === "--credits" && argv[i + 1]) creditsPath = argv[++i];
  }

  return {
    kit,
    assetsRoot: resolve(assetsRoot),
    outDir: resolve(outDir),
    target,
    creditsPath: creditsPath && existsSync(resolve(creditsPath)) ? resolve(creditsPath) : undefined,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const res = bakeKitGeometry({
    assetsRoot: args.assetsRoot,
    outDir: args.outDir,
    kit: args.kit,
    target: args.target,
    creditsPath: args.creditsPath,
  });
  try {
    const report = {
      kit: args.kit,
      target: args.target,
      bakedCount: res.bakedCount,
      uniqueBlobCount: res.uniqueBlobCount,
      rejectedCount: res.rejectedCount,
      chunkId: res.manifest.chunkId,
      chunkHash: res.manifest.chunkHash,
      chunkBytes: res.manifest.chunkBytes,
      manifestPath: res.manifestPath,
      chunkPath: res.chunkPath,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    res.store.close();
  }
}

main();
