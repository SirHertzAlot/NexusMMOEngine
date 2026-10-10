/**
 * gltfpack compression step (TL1b).
 *
 * Runs the gltfpack binary (pinned at v1.3, see packages/art/README.md)
 * with meshopt compression (`-cc`) over GLB files. Geometry only — textures
 * are handled by the gltf-transform step (TL1c).
 *
 * The binary path is config: set `GLTFPACK_BIN` env or pass `binPath`.
 * Defaults to `gltfpack` on PATH.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";

const execFileAsync = promisify(execFile);

export interface CompressResult {
  /** Input file path. */
  input: string;
  /** Output file path. */
  output: string;
  /** Bytes before compression. */
  rawBytes: number;
  /** Bytes after compression. */
  compressedBytes: number;
  /** Compression ratio (0-1, lower is better). */
  ratio: number;
}

export interface CompressOptions {
  /** Path to the gltfpack binary. Defaults to `gltfpack` on PATH or `GLTFPACK_BIN`. */
  binPath?: string;
  /** Output path. Defaults to input with `.compressed.glb` suffix. */
  output?: string;
}

/**
 * Compress a GLB with gltfpack (meshopt -cc).
 * Throws if the binary is missing or compression fails.
 */
export async function compressGlb(
  input: string,
  options: CompressOptions = {}
): Promise<CompressResult> {
  const bin = options.binPath ?? process.env.GLTFPACK_BIN ?? "gltfpack";
  const output = options.output ?? input.replace(/\.glb$/, ".compressed.glb");

  const rawBytes = statSync(input).size;

  // -cc: meshopt compression + quantization
  // -v: verbose (for logging)
  await execFileAsync(bin, ["-i", input, "-o", output, "-cc", "-v"]);

  const compressedBytes = statSync(output).size;

  return {
    input,
    output,
    rawBytes,
    compressedBytes,
    ratio: compressedBytes / rawBytes,
  };
}

/**
 * Check if the gltfpack binary is available.
 */
export async function hasGltfpack(binPath?: string): Promise<boolean> {
  const bin = binPath ?? process.env.GLTFPACK_BIN ?? "gltfpack";
  try {
    await execFileAsync(bin, ["-h"]);
    return true;
  } catch (e: any) {
    // gltfpack -h prints help but exits non-zero; check stdout for the banner
    const output = String(e.stdout ?? "") + String(e.stderr ?? "");
    return output.includes("gltfpack");
  }
}
