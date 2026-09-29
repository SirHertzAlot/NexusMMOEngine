#!/usr/bin/env node
/**
 * Fetch the terrain surface textures: CC0 photo-scanned ground materials
 * (Poly Haven, ambientCG) prepared by ProceduralTerrains into packed,
 * mip-mapped RGBA8 files, written to apps/client/public/surfaces/ (git
 * ignored: never committed). Without them the client keeps its flat
 * biome colours.
 *
 *   npm run surfaces:fetch --workspace=@mmo-engine/client
 *   npm run surfaces:fetch --workspace=@mmo-engine/client -- --from <dir>
 *
 * Default: downloads each material's 512 px file from the ProceduralTerrains
 * repository at a pinned commit and checks it against the SHA-256 in that
 * commit's catalog. `--from <dir>`: copies them from a local prepared set
 * (a checkout's public/textures/terrain/pbr) instead, with the same checks.
 *
 * Output: <id>.pbr per material (zlib-deflated RGBA8 levels: colour+height,
 * then normal.xy+roughness+AO, for each mip level), manifest.json (layers,
 * tile sizes, biome assignments), and ATTRIBUTION.md.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const REPO = "ZyFou/ProceduralTerrains";
const COMMIT = "96c094e";
const RAW = `https://raw.githubusercontent.com/${REPO}/${COMMIT}/public/textures/terrain/pbr`;
const RESOLUTION = 512;
const OUT = path.resolve(import.meta.dirname, "..", "public", "surfaces");

/** Layers: our id, the source asset, a linear albedo multiplier, and a tile size floor (m). */
const LAYERS = [
  { id: "grass", source: "Grass004", tint: [1, 1, 1] },
  { id: "forest-floor", source: "forest_ground_04", tint: [1, 1, 1] },
  { id: "moss", source: "Ground037", tint: [0.85, 0.94, 0.8] },
  { id: "dune-sand", source: "sand_02", tint: [1.35, 1.25, 1.1] },
  { id: "beach-sand", source: "sand_03", tint: [1.6, 1.6, 1.7] },
  { id: "mud", source: "brown_mud", tint: [0.7, 0.7, 0.7] },
  { id: "rocky-ground", source: "rocky_terrain_02", tint: [1, 1, 1] },
  { id: "tundra", source: "aerial_grass_rock", tint: [1, 1, 1] },
  { id: "snow", source: "snow_02", tint: [2.2, 2.2, 2.2] },
  { id: "volcanic", source: "rock_boulder_cracked", tint: [0.23, 0.24, 0.26] },
  { id: "rock", source: "rock_face", tint: [1, 1, 1] },
];

/** Biome -> ground layer; slopes use "rock", peaks "snow". */
const BIOMES = {
  plains: "grass",
  forest: "forest-floor",
  rainforest: "moss",
  desert: "dune-sand",
  beach: "beach-sand",
  swamp: "mud",
  mountains: "rocky-ground",
  tundra: "tundra",
  snow: "snow",
  glacier: "snow",
  volcanic: "volcanic",
  sea: "beach-sand",
  lake: "mud",
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readSource(from, rel) {
  if (from) return fs.readFile(path.join(from, rel));
  const res = await fetch(`${RAW}/${rel}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${RAW}/${rel}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const i = process.argv.indexOf("--from");
  const from = i > 0 ? path.resolve(process.argv[i + 1]) : null;
  console.log(from ? `surfaces: from ${from}` : `surfaces: from ${REPO}@${COMMIT}`);
  const catalog = JSON.parse((await readSource(from, "catalog.json")).toString("utf8"));
  await fs.mkdir(OUT, { recursive: true });

  const layers = [];
  const credits = [];
  for (const layer of LAYERS) {
    const asset = catalog.assets.find((a) => a.sourceId === layer.source);
    if (!asset) throw new Error(`catalog has no asset ${layer.source}`);
    if (asset.license !== "CC0-1.0") throw new Error(`${layer.source}: license ${asset.license}, want CC0-1.0`);
    const file = asset.resolutions[String(RESOLUTION)];
    const bytes = await readSource(from, file.path);
    if (sha256(bytes) !== file.sha256) throw new Error(`${file.path}: SHA-256 mismatch`);
    await fs.writeFile(path.join(OUT, `${layer.id}.pbr`), bytes);
    const tile = Math.max(2, ...(asset.physicalSize ?? [2]));
    layers.push({ id: layer.id, file: `${layer.id}.pbr`, resolution: RESOLUTION, levels: file.levels, tileMetres: tile, tint: layer.tint });
    credits.push(`- **${layer.id}**: ${asset.name} by ${asset.authors.join(", ")} (${asset.provider}), ${asset.sourceUrl}, CC0-1.0`);
    console.log(`  ${layer.id.padEnd(13)} ${asset.name} (${(bytes.length / 1e6).toFixed(1)} MB)`);
  }
  const manifest = { version: 1, source: `${REPO}@${COMMIT}`, encoding: "deflate-rgba8-mips-v1", layers, biomes: BIOMES, rock: "rock", snow: "snow" };
  await fs.writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await fs.writeFile(
    path.join(OUT, "ATTRIBUTION.md"),
    [
      "# Terrain surface textures",
      "",
      "All CC0-1.0 (public domain); credit is courtesy. Prepared (2K normalised,",
      `packed, mip-mapped) by ProceduralTerrains (${REPO}@${COMMIT}, MIT).`,
      "",
      ...credits,
      "",
    ].join("\n"),
  );
  console.log(`surfaces: ${layers.length} layers in ${OUT}`);
}

main().catch((e) => {
  console.error(`surfaces: ${e.message}`);
  process.exit(1);
});
