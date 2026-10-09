/**
 * The pipeline runner: expands each stage's inputs (files and
 * directories), hashes them, skips stages whose inputs haven't changed,
 * and runs the rest in order — fail-fast, like CI.
 */
import { exec } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { hashFiles } from "./hash.js";
import { stageNeedsRun, writeStageCache } from "./cache.js";
import type { BuildProfile } from "./profile.js";

const execAsync = promisify(exec);

export interface StageResult {
  id: string;
  skipped: boolean;
  /** null when the stage was skipped or dry-run. */
  exitCode: number | null;
  ms: number;
}

export interface RunOptions {
  cacheDir?: string;
  dryRun?: boolean;
}

/** Expand inputs (files and directories) to sorted, deduped repo-relative file paths. */
export function collectInputFiles(rootDir: string, inputs: string[]): string[] {
  const out = new Set<string>();
  for (const input of inputs) {
    const abs = join(rootDir, input);
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new Error(`collectInputFiles: input not found: ${input}`);
    }
    if (st.isFile()) {
      out.add(input);
    } else if (st.isDirectory()) {
      walk(abs, rootDir, out);
    } else {
      throw new Error(`collectInputFiles: not a file or directory: ${input}`);
    }
  }
  return [...out].sort();
}

function walk(abs: string, rootDir: string, out: Set<string>): void {
  for (const entry of readdirSync(abs)) {
    const child = join(abs, entry);
    const st = statSync(child);
    if (st.isDirectory()) walk(child, rootDir, out);
    else if (st.isFile()) out.add(relative(rootDir, child));
  }
}

/** Run a profile. Returns one result per stage attempted (fail-fast on error). */
export async function runProfile(
  rootDir: string,
  profile: BuildProfile,
  opts: RunOptions = {},
): Promise<StageResult[]> {
  const cacheDir = opts.cacheDir ?? join(rootDir, ".build-cache");
  const results: StageResult[] = [];
  for (const stage of profile.stages) {
    const files = collectInputFiles(rootDir, stage.inputs);
    const hash = hashFiles(rootDir, files);
    if (!stageNeedsRun(cacheDir, stage.id, hash)) {
      results.push({ id: stage.id, skipped: true, exitCode: null, ms: 0 });
      continue;
    }
    if (opts.dryRun) {
      results.push({ id: stage.id, skipped: false, exitCode: null, ms: 0 });
      continue;
    }
    const start = Date.now();
    try {
      await execAsync(stage.command, { cwd: rootDir, maxBuffer: 64 * 1024 * 1024 });
      writeStageCache(cacheDir, stage.id, hash);
      results.push({ id: stage.id, skipped: false, exitCode: 0, ms: Date.now() - start });
    } catch (err) {
      const exitCode =
        err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "number"
          ? (err as { code: number }).code
          : 1;
      results.push({ id: stage.id, skipped: false, exitCode, ms: Date.now() - start });
      break; // fail-fast
    }
  }
  return results;
}
