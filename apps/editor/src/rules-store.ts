/**
 * The gameplay tables (roadmap ED1): read and save the rules files the
 * editor edits — item bases, creatures, loot and death — from
 * content/rules/. A save is validated the way the server loads it (every
 * rules file, with the edited one substituted, through `parseRules`), so
 * the editor can never write a table the server would refuse; a refused
 * save returns every issue with its file and field and writes nothing.
 *
 * Node-only: the editor's dev host (host.ts) serves it on /api/editor/rules.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseRules, RULE_FILES, RulesError, type RuleFile, type RulesIssue } from "@mmo-engine/rules";

/** The rules files the editor's tables edit. */
export const EDITABLE_TABLES = ["items", "creatures", "combat", "body", "loot", "death", "ingress", "gathering"] as const;
export type EditableTable = (typeof EDITABLE_TABLES)[number];

export function isEditableTable(name: unknown): name is EditableTable {
  return typeof name === "string" && (EDITABLE_TABLES as readonly string[]).includes(name);
}

export interface RulesTables {
  /** Each editable file's JSON as written (an absent file is `{}`: the engine defaults). */
  tables: Record<EditableTable, unknown>;
  /** combat.json's technique ids, for the item bases' technique choice. */
  techniques: string[];
  /** skills.json's skill ids, for a technique's skill. */
  skills: string[];
}

export type SaveResult = { ok: true } | { ok: false; issues: RulesIssue[] };

function readJson(file: string): unknown {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

/** Every rules file in `dir`, parsed but not validated (absent files left out). */
function readAll(dir: string): Partial<Record<RuleFile, unknown>> {
  const out: Partial<Record<RuleFile, unknown>> = {};
  for (const name of Object.keys(RULE_FILES) as RuleFile[]) {
    const json = readJson(path.join(dir, `${name}.json`));
    if (json !== undefined) out[name] = json;
  }
  return out;
}

export function readRulesTables(dir: string): RulesTables {
  const all = readAll(dir);
  const tables = {} as Record<EditableTable, unknown>;
  for (const t of EDITABLE_TABLES) tables[t] = all[t] ?? {};
  // The validated rules give the techniques with defaults filled in.
  let techniques: string[] = [];
  let skills: string[] = [];
  try {
    const rules = parseRules(all);
    techniques = Object.keys(rules.combat.techniques);
    skills = rules.skills.skills.map((s) => s.id);
  } catch {
    const raw = all.combat as { techniques?: Record<string, unknown> } | undefined;
    techniques = Object.keys(raw?.techniques ?? {});
    const rawSkills = all.skills as { skills?: Array<{ id?: unknown }> } | undefined;
    skills = (rawSkills?.skills ?? []).map((s) => s.id).filter((s): s is string => typeof s === "string");
  }
  return { tables, techniques, skills };
}

/**
 * Validate `json` as `table` against the other rules files in `dir` and,
 * when it passes, write it (atomically: a temporary file renamed over the
 * old one, so the server's watcher never reads half a file).
 */
export function saveRulesTable(dir: string, table: EditableTable, json: unknown): SaveResult {
  let all: Partial<Record<RuleFile, unknown>>;
  try {
    all = readAll(dir);
  } catch (err) {
    return { ok: false, issues: [{ file: "", path: "", message: `the rules folder doesn't read: ${(err as Error).message}` }] };
  }
  all[table] = json;
  try {
    parseRules(all);
  } catch (err) {
    if (err instanceof RulesError) return { ok: false, issues: err.issues };
    throw err;
  }
  const file = path.join(dir, `${table}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { ok: true };
}
