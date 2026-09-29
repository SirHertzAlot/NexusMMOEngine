/**
 * Loading the rules: content/rules/<name>.json for each rules file, each
 * validated by its schema (missing fields take the engine default, a
 * missing file is the engine default), then checked across files (skill
 * ids that exist, a body tree with one root whose shares add up, …).
 *
 * Every problem is reported with its file and field, all at once:
 *
 *   body.json: parts[3].share: Too big: expected number to be <=1
 *   disciplines.json: disciplines[0].requires.staffs: no skill "staffs"
 *
 * The server refuses to start while there are any.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { z } from "zod";
import { RULE_FILES, type RuleFile, type Rules } from "./schemas.js";

export interface RulesIssue {
  /** The rules file, e.g. "body.json". */
  file: string;
  /** Where in it, e.g. "parts[3].share" ("" for the file itself). */
  path: string;
  message: string;
}

export class RulesError extends Error {
  constructor(readonly issues: RulesIssue[]) {
    super(`invalid rules:\n${issues.map(formatIssue).join("\n")}`);
    this.name = "RulesError";
  }
}

export function formatIssue(i: RulesIssue): string {
  return `  ${i.file}${i.path ? `: ${i.path}` : ""}: ${i.message}`;
}

function pathString(p: ReadonlyArray<PropertyKey>): string {
  let s = "";
  for (const k of p) s += typeof k === "number" ? `[${k}]` : s ? `.${String(k)}` : String(k);
  return s;
}

/**
 * Rules from already-parsed JSON, keyed by file name ("skills", "body", …).
 * Absent keys are the engine default. Throws RulesError listing every issue.
 */
export function parseRules(sources: Partial<Record<RuleFile, unknown>>): Rules {
  const issues: RulesIssue[] = [];
  const out: Partial<Rules> = {};
  for (const name of Object.keys(RULE_FILES) as RuleFile[]) {
    const schema = RULE_FILES[name] as z.ZodType;
    const result = schema.safeParse(sources[name] ?? {});
    if (result.success) (out as Record<string, unknown>)[name] = result.data;
    else for (const i of result.error.issues) issues.push({ file: `${name}.json`, path: pathString(i.path), message: i.message });
  }
  // Cross-file checks run even when some files failed (on defaults in their
  // place), so every problem is reported at once; checks that lean on a
  // failed file are skipped rather than reported as false alarms.
  const failed = new Set(issues.map((i) => i.file.slice(0, -".json".length) as RuleFile));
  if (failed.size > 0) {
    const defaults = engineDefaults();
    for (const name of failed) (out as Record<string, unknown>)[name] = defaults[name];
  }
  const skip = new Set<RuleFile>(failed);
  for (const [file, deps] of Object.entries(DEPENDS_ON) as [RuleFile, RuleFile[]][]) {
    if (deps.some((d) => failed.has(d))) skip.add(file);
  }
  issues.push(...crossCheck(out as Rules).filter((i) => !skip.has(i.file.slice(0, -".json".length) as RuleFile)));
  if (issues.length > 0) throw new RulesError(issues);
  return out as Rules;
}

/** Which files' cross-checks read another file's ids. */
const DEPENDS_ON: Record<RuleFile, RuleFile[]> = {
  skills: [],
  disciplines: ["skills"],
  combat: ["skills"],
  body: [],
  death: [],
  appearance: ["body"],
};

let defaults: Rules | null = null;

/** The engine's neutral defaults: what a game with no rules files plays by. */
export function engineDefaults(): Rules {
  defaults ??= parseRules({});
  return structuredClone(defaults);
}

/**
 * Load the rules folder. Every `<name>.json` must be one of the rules
 * files (a misspelt file name is an error, not an ignored file); missing
 * files are the engine default.
 */
export function loadRules(dir: string): Rules {
  const issues: RulesIssue[] = [];
  const sources: Partial<Record<RuleFile, unknown>> = {};
  const known = new Set(Object.keys(RULE_FILES));
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    throw new RulesError([{ file: dir, path: "", message: "rules folder not found" }]);
  }
  for (const entry of entries.filter((e) => e.endsWith(".json")).sort()) {
    const name = entry.slice(0, -".json".length);
    if (!known.has(name)) {
      issues.push({ file: entry, path: "", message: `not a rules file (expected one of: ${[...known].map((k) => `${k}.json`).join(", ")})` });
      continue;
    }
    try {
      sources[name as RuleFile] = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8"));
    } catch (e) {
      issues.push({ file: entry, path: "", message: `not valid JSON: ${(e as Error).message}` });
    }
  }
  if (issues.length > 0) throw new RulesError(issues);
  return parseRules(sources);
}

/** Checks that span fields or files: ids that must exist, a sound body tree. */
function crossCheck(r: Rules): RulesIssue[] {
  const issues: RulesIssue[] = [];
  const add = (file: RuleFile, p: string, message: string): void => void issues.push({ file: `${file}.json`, path: p, message });
  const dupes = (file: RuleFile, list: { id: string }[], where: string): void => {
    const seen = new Set<string>();
    list.forEach((x, i) => {
      if (seen.has(x.id)) add(file, `${where}[${i}].id`, `"${x.id}" is used twice`);
      seen.add(x.id);
    });
  };

  // Skills.
  const skills = new Set(r.skills.skills.map((s) => s.id));
  dupes("skills", r.skills.skills, "skills");
  const families = new Set(r.skills.families);
  r.skills.skills.forEach((s, i) => {
    if (families.size > 0 && !families.has(s.family)) add("skills", `skills[${i}].family`, `no family "${s.family}" in families`);
    for (const rel of Object.keys(s.related)) {
      if (rel === s.id) add("skills", `skills[${i}].related.${rel}`, "a skill can't be related to itself");
      else if (!skills.has(rel)) add("skills", `skills[${i}].related.${rel}`, `no skill "${rel}"`);
    }
  });
  if (r.skills.gain.fullAt <= r.skills.gain.trivialBelow) add("skills", "gain.fullAt", "must be above gain.trivialBelow");

  // Disciplines.
  dupes("disciplines", r.disciplines.disciplines, "disciplines");
  r.disciplines.disciplines.forEach((d, i) => {
    for (const [skill, level] of Object.entries(d.requires)) {
      if (!skills.has(skill)) add("disciplines", `disciplines[${i}].requires.${skill}`, `no skill "${skill}"`);
      else if (level > r.skills.max) add("disciplines", `disciplines[${i}].requires.${skill}`, `above the skill maximum (${r.skills.max})`);
    }
  });

  // Combat.
  for (const [t, def] of Object.entries(r.combat.techniques)) {
    if (def.skill !== undefined && !skills.has(def.skill)) add("combat", `techniques.${t}.skill`, `no skill "${def.skill}"`);
  }

  // Body: one root, parents that exist, no loops, shares that add up.
  const parts = r.body.parts;
  dupes("body", parts, "parts");
  const byId = new Map(parts.map((p) => [p.id, p]));
  const roots = parts.filter((p) => p.parent === null);
  if (roots.length !== 1) add("body", "parts", `needs exactly one root part (parent: null), has ${roots.length}`);
  parts.forEach((p, i) => {
    if (p.parent !== null && !byId.has(p.parent)) add("body", `parts[${i}].parent`, `no part "${p.parent}"`);
    const seen = new Set<string>();
    for (let q: typeof p | undefined = p; q && q.parent !== null; q = byId.get(q.parent)) {
      if (seen.has(q.id)) {
        add("body", `parts[${i}].parent`, `"${p.id}" is its own ancestor`);
        break;
      }
      seen.add(q.id);
    }
  });
  const total = parts.reduce((s, p) => s + p.share, 0);
  if (Math.abs(total - 1) > 0.005) add("body", "parts", `shares add up to ${total.toFixed(3)}, not 1`);

  // Appearance.
  dupes("appearance", r.appearance.slots, "slots");
  r.appearance.slots.forEach((s, i) => {
    if (s.part !== undefined && !byId.has(s.part)) add("appearance", `slots[${i}].part`, `no body part "${s.part}"`);
  });
  return issues;
}
