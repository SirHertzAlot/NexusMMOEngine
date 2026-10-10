/**
 * Package manifest: what shipped, with per-file hashes. Written at
 * package time, verified at deploy time (tampered or missing files
 * fail the deploy, loudly).
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const ManifestFile = z.object({
  path: z.string().min(1),
  sha256: z.string().length(64),
  bytes: z.number().int().nonnegative(),
});

export const PackageManifest = z.object({
  profile: z.string().min(1),
  createdAt: z.string().min(1),
  files: z.array(ManifestFile),
});

export type PackageManifest = z.infer<typeof PackageManifest>;

function sha256File(abs: string): { sha256: string; bytes: number } {
  const bytes = readFileSync(abs);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

/** Build a manifest for `files` (relative to rootDir). */
export function buildManifest(rootDir: string, profile: string, files: string[]): PackageManifest {
  return {
    profile,
    createdAt: new Date().toISOString(),
    files: [...files].sort().map((rel) => {
      const { sha256, bytes } = sha256File(join(rootDir, rel));
      // Touch statSync so a directory (not a file) fails fast with a clear error.
      const st = statSync(join(rootDir, rel));
      if (!st.isFile()) throw new Error(`buildManifest: not a file: ${rel}`);
      return { path: rel, sha256, bytes };
    }),
  };
}

/** Verify a manifest against rootDir. Every problem is reported, not just the first. */
export function verifyManifest(
  rootDir: string,
  manifest: PackageManifest,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const f of manifest.files) {
    const abs = join(rootDir, f.path);
    let disk: { sha256: string; bytes: number };
    try {
      disk = sha256File(abs);
    } catch {
      problems.push(`missing: ${f.path}`);
      continue;
    }
    if (disk.sha256 !== f.sha256) problems.push(`tampered: ${f.path}`);
    else if (disk.bytes !== f.bytes) problems.push(`size changed: ${f.path}`);
  }
  return { ok: problems.length === 0, problems };
}
