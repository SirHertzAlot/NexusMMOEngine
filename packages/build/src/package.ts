/**
 * Package assembly: copy the listed files (repo-relative) into the
 * output dir preserving paths, and write manifest.json beside them.
 * Throws on a missing file — a package that silently drops files is
 * worse than no package.
 */
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildManifest, type PackageManifest } from "./manifest.js";

export function assemblePackage(
  rootDir: string,
  outDir: string,
  profile: string,
  files: string[],
): PackageManifest {
  for (const rel of files) {
    const abs = join(rootDir, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new Error(`assemblePackage: not a file: ${rel}`);
    }
  }
  for (const rel of files) {
    const dest = join(outDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(rootDir, rel), dest);
  }
  const manifest = buildManifest(rootDir, profile, files);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
