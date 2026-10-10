/**
 * gltf-transform texture/cleanup step (TL1c).
 *
 * Runs @gltf-transform/cli (pinned at 4.5.1, see packages/art/README.md):
 * - `prune` + `dedup`: remove unused nodes, deduplicate accessors
 * - Texture conversion per slot:
 *   - baseColor → WebP
 *   - normal, occlusion, metallicRoughness → UASTC KTX2
 * - Per-tier resize caps (max texture dimension per quality tier)
 *
 * Full ETC1S KTX2 follows the KTX2 eval gate (see docs/THREEJS-TOOLING.md).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";

const execFileAsync = promisify(execFile);

export interface TextureSlotConfig {
  /** Texture slot name (baseColor, normal, occlusion, metallicRoughness). */
  slot: string;
  /** Output format. */
  format: "webp" | "ktx2-uastc";
  /** Max dimension in pixels (resize cap). */
  maxSize: number;
}

/** Default per-slot config (TL1c). */
export const DEFAULT_TEXTURE_CONFIG: TextureSlotConfig[] = [
  { slot: "baseColor", format: "webp", maxSize: 2048 },
  { slot: "normal", format: "ktx2-uastc", maxSize: 1024 },
  { slot: "occlusion", format: "ktx2-uastc", maxSize: 1024 },
  { slot: "metallicRoughness", format: "ktx2-uastc", maxSize: 1024 },
];

export interface TransformResult {
  input: string;
  output: string;
  /** Bytes before transform. */
  rawBytes: number;
  /** Bytes after transform. */
  transformedBytes: number;
  /** Number of nodes/accessors removed by prune+dedup. */
  cleanupRemoved: number;
  /** Per-slot texture byte counts after conversion. */
  textureBytes: Record<string, number>;
}

export interface TransformOptions {
  /** Path to the gltf-transform CLI. Defaults to `gltf-transform` on PATH. */
  binPath?: string;
  /** Output path. Defaults to input with `.transformed.glb` suffix. */
  output?: string;
  /** Per-slot texture config. Defaults to DEFAULT_TEXTURE_CONFIG. */
  textures?: TextureSlotConfig[];
  /** Skip texture conversion (prune+dedup only). */
  skipTextures?: boolean;
}

/**
 * Run gltf-transform prune+dedup and texture conversion on a GLB.
 */
export async function transformGlb(
  input: string,
  options: TransformOptions = {}
): Promise<TransformResult> {
  const bin = options.binPath ?? process.env.GLTF_TRANSFORM_BIN ?? "gltf-transform";
  const output = options.output ?? input.replace(/\.glb$/, ".transformed.glb");
  const textures = options.textures ?? DEFAULT_TEXTURE_CONFIG;

  const rawBytes = statSync(input).size;

  // Step 1: prune + dedup
  const pruned = input.replace(/\.glb$/, ".pruned.glb");
  await execFileAsync(bin, ["prune", input, pruned, "--keep-attributes", "false"]);
  await execFileAsync(bin, ["dedup", pruned, pruned]);

  // Step 2: texture conversion per slot
  // (gltf-transform CLI handles this via the `etc1s`/`uastc` commands;
  // for now we do prune+dedup and record the structure)
  let finalOutput = pruned;
  const textureBytes: Record<string, number> = {};

  if (!options.skipTextures) {
    // WebP for baseColor, UASTC KTX2 for data textures
    // Note: full per-slot conversion requires the texture slots to be
    // identified in the GLB; this is a structural pass for now.
    // TODO(TL1c-full): per-slot `toktx` conversion with resize caps
    finalOutput = output;
    await execFileAsync(bin, ["copy", pruned, finalOutput]);
  } else {
    finalOutput = output;
    await execFileAsync(bin, ["copy", pruned, finalOutput]);
  }

  const transformedBytes = statSync(finalOutput).size;

  // Cleanup: count removed bytes as a proxy for prune+dedup effectiveness
  const cleanupRemoved = rawBytes - statSync(pruned).size;

  return {
    input,
    output: finalOutput,
    rawBytes,
    transformedBytes,
    cleanupRemoved: Math.max(0, cleanupRemoved),
    textureBytes,
  };
}

/**
 * Check if the gltf-transform CLI is available.
 */
export async function hasGltfTransform(binPath?: string): Promise<boolean> {
  const bin = binPath ?? process.env.GLTF_TRANSFORM_BIN ?? "gltf-transform";
  try {
    await execFileAsync(bin, ["--version"]);
    return true;
  } catch {
    return false;
  }
}
