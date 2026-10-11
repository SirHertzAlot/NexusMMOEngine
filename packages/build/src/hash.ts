/**
 * Input hashing: sha256 over sorted (relativePath, content) pairs.
 * Format per file: the UTF-8 bytes of "<relPath>\n" followed by the raw
 * file bytes. Paths are part of the hash, so same-named files in
 * different directories hash differently. Missing files throw — a
 * profile naming a file that doesn't exist is wrong, not empty.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function hashFiles(rootDir: string, files: string[]): string {
  const sorted = [...files].sort();
  const h = createHash("sha256");
  for (const rel of sorted) {
    const abs = join(rootDir, rel);
    let bytes: Buffer;
    try {
      bytes = readFileSync(abs);
    } catch {
      throw new Error(`hashFiles: input not found: ${rel}`);
    }
    h.update(rel + "\n", "utf8");
    h.update(bytes);
  }
  return h.digest("hex");
}
