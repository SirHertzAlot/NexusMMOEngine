/**
 * Rules file storage for the editor dev host (roadmap E11).
 *
 * The browser cannot touch the filesystem, so the dev host serves
 * `content/rules/*.json` over three loopback-only routes (wired in
 * host.ts):
 *
 *   GET /api/editor/rules       → { files: ["appearance", "body", …] }
 *   GET /api/editor/rules/:name → { name, content, missing? }
 *   PUT /api/editor/rules/:name → { content } → validate, then write
 *
 * Safety rules (same posture as the rest of host.ts):
 * - The file name is whitelisted against RULE_FILES from
 *   `@mmo-engine/rules` — never a raw path, so no traversal.
 * - The resolved path is confined to <repo>/content/rules (normalized
 *   containment check, defence in depth).
 * - A save is validated with the package's parse API (`parseRules` over
 *   the candidate plus the on-disk siblings, so schema AND cross-file
 *   checks run) and written back pretty-printed (2 spaces, same key
 *   order) only when there are zero issues. Errors come back per path.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  RULE_FILES,
  engineDefaults,
  parseRules,
  RulesError,
  type RuleFile,
  type RulesIssue,
} from "@mmo-engine/rules";
import { refuseInvalid } from "./api.js";

/** Every rules file, in RULE_FILES order (content/rules/<name>.json). */
export function ruleFileNames(): RuleFile[] {
  return Object.keys(RULE_FILES) as RuleFile[];
}

/** Whitelist: only a RULE_FILES key is ever resolved to a path. */
export function isRuleFile(name: string): name is RuleFile {
  return Object.prototype.hasOwnProperty.call(RULE_FILES, name);
}

/** <repo>/content/rules — the only directory rules reads/writes touch. */
export function rulesDir(repoRoot: string): string {
  return resolve(repoRoot, "content", "rules");
}

/**
 * Absolute path of a rules file. Throws { status: 404 } for anything
 * that is not a whitelisted name (unknown files, traversal attempts,
 * slashes of any kind), { status: 500 } if it escapes the rules dir.
 */
export function resolveRulePath(repoRoot: string, name: string): string {
  if (!isRuleFile(name)) {
    throw Object.assign(new Error(`unknown rules file "${name}" (expected one of: ${ruleFileNames().map((k) => `${k}.json`).join(", ")})`), {
      status: 404,
    });
  }
  const dir = rulesDir(repoRoot);
  // Whitelisted names hold no separators, so this join cannot escape;
  // the prefix check below is defence in depth (same posture as the
  // /assets static route in host.ts).
  const abs = join(dir, `${name}.json`);
  if (!abs.startsWith(dir + sep)) {
    throw Object.assign(new Error("path escapes rules root"), { status: 500 });
  }
  return abs;
}

/** Pretty-print for write-back: 2 spaces, same key order, trailing newline. */
export function prettyPrintRules(content: unknown): string {
  return `${JSON.stringify(content, null, 2)}\n`;
}

/**
 * Validate a save candidate with the package's parse API: the candidate
 * takes the place of its on-disk file, every sibling is read as-is
 * (absent = engine default, unparseable = reported like the server
 * reports it), then parseRules runs the Zod schemas plus the
 * cross-file checks. Returns every issue (empty = safe to write).
 */
export function checkRuleSave(repoRoot: string, name: RuleFile, content: unknown): RulesIssue[] {
  const dir = rulesDir(repoRoot);
  const known: RulesIssue[] = [];
  const sources: Partial<Record<RuleFile, unknown>> = {};
  for (const key of ruleFileNames()) {
    if (key === name) {
      sources[key] = content;
      continue;
    }
    const file = join(dir, `${key}.json`);
    if (!existsSync(file)) continue;
    try {
      sources[key] = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch (e) {
      known.push({ file: `${key}.json`, path: "", message: `not valid JSON: ${(e as Error).message}` });
    }
  }
  try {
    parseRules(sources);
  } catch (e) {
    if (e instanceof RulesError) return [...known, ...e.issues];
    throw e;
  }
  return known;
}

/** Read one rules file: parsed content, or the engine default when absent. */
export function readRuleFile(
  repoRoot: string,
  name: RuleFile,
): { content: unknown; missing: boolean } {
  const file = resolveRulePath(repoRoot, name);
  if (!existsSync(file)) return { content: engineDefaults()[name], missing: true };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw Object.assign(new Error(`cannot read ${name}.json: ${(e as Error).message}`), { status: 500 });
  }
  try {
    return { content: JSON.parse(text) as unknown, missing: false };
  } catch (e) {
    throw Object.assign(new Error(`${name}.json: not valid JSON: ${(e as Error).message}`), { status: 500 });
  }
}

/**
 * Validate then write. Throws { status: 400, issues } when the rules
 * would be invalid — nothing is written in that case.
 */
export function saveRuleFile(repoRoot: string, name: RuleFile, content: unknown): void {
  const issues = checkRuleSave(repoRoot, name, content);
  if (issues.length > 0) {
    throw refuseInvalid("rules", issues);
  }
  writeFileSync(resolveRulePath(repoRoot, name), prettyPrintRules(content), "utf8");
}
