/**
 * Test fixtures made on the fly: a temp dir holding the given files, removed
 * when the process exits, and the repo's content/<name> found by walking up
 * from the test file (the same path under src/ or dist/).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const made: string[] = [];
process.on("exit", () => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A fresh temp dir holding `files` (name to text); `{}` makes an empty dir. */
export function fixtureDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "engine-fixture-"));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

/** A path under tmp that does not exist. */
export function missingDir(): string {
  return join(fixtureDir(), "missing");
}

/** The repo's content/<name>, found from a test file's own directory. */
export function repoContentDir(testDir: string, name: string): string {
  for (let d = resolve(testDir); dirname(d) !== d; d = dirname(d)) {
    if (existsSync(join(d, "content", name))) return join(d, "content", name);
  }
  throw new Error(`no content/${name} above ${testDir}`);
}
