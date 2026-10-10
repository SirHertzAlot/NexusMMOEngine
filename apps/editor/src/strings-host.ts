/**
 * Localization string tables for the editor dev host (roadmap EA25). One
 * file per language, `<repo>/content/strings/<lang>.json` (string id to ICU
 * message, English is the source), the same files the client inlines.
 * Loopback routes (wired in host.ts):
 *
 *   GET /api/editor/strings → { ok, langs, tables }
 *   PUT /api/editor/strings → { tables: { <lang>: { id: message } } } → validate, then write
 *
 * A PUT carries only the languages that changed; they are checked in place
 * of their files next to the siblings on disk with the shared rules of
 * @mmo-engine/scene (`validateTables`: ids, ICU, placeholders against the
 * English source). A refused save answers 400 with every issue and writes
 * nothing. The language code is whitelisted, never a raw path; the
 * pseudo-locale is derived, not a file.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isLangCode, loadStrings, SOURCE_LANG, validateTables, type StringIssue, type StringTables } from "@mmo-engine/scene";
import { failureReply, jsonBodyField, refuseInvalid, type RouteReply } from "./api.js";

export const stringsDir = (repoRoot: string): string => resolve(repoRoot, "content", "strings");

/** The languages on disk, English first. */
export function listLangs(repoRoot: string): string[] {
  const dir = stringsDir(repoRoot);
  const found = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter(isLangCode) : [];
  return found.sort((a, b) => (a === SOURCE_LANG ? -1 : b === SOURCE_LANG ? 1 : a.localeCompare(b)));
}

export function readStrings(repoRoot: string): StringTables {
  const tables: StringTables = {};
  for (const lang of listLangs(repoRoot)) {
    try {
      tables[lang] = loadStrings(JSON.parse(readFileSync(join(stringsDir(repoRoot), `${lang}.json`), "utf8")));
    } catch (e) {
      throw Object.assign(new Error(`${lang}.json: ${(e as Error).message}`), { status: 500 });
    }
  }
  return tables;
}

/** Validate `changes` against the tables on disk, then write them. Throws { status: 400, issues } and writes nothing when invalid. */
export function saveStrings(repoRoot: string, changes: unknown): string[] {
  if (typeof changes !== "object" || changes === null || Array.isArray(changes)) throw Object.assign(new Error('need {"tables": {"<lang>": {…}}}'), { status: 400 });
  const issues: StringIssue[] = [];
  const parsed: StringTables = {};
  for (const [lang, table] of Object.entries(changes)) {
    if (!isLangCode(lang)) {
      issues.push({ lang, id: "", message: `"${lang}" is not a language code (like en or pt-BR)` });
      continue;
    }
    try {
      parsed[lang] = loadStrings(table);
    } catch (e) {
      issues.push({ lang, id: "", message: (e as Error).message });
    }
  }
  const candidate: StringTables = { ...readStrings(repoRoot), ...parsed };
  if (candidate[SOURCE_LANG] === undefined) issues.push({ lang: SOURCE_LANG, id: "", message: "the English source table is missing" });
  issues.push(...validateTables(candidate));
  if (issues.length > 0) throw refuseInvalid("strings", issues);
  mkdirSync(stringsDir(repoRoot), { recursive: true });
  for (const [lang, table] of Object.entries(parsed)) {
    const file = join(stringsDir(repoRoot), `${lang}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(table, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  }
  return Object.keys(parsed);
}

export function handleStringsRoute(repoRoot: string, method: string, pathname: string, body: string | undefined): RouteReply | null {
  if (pathname !== "/api/editor/strings" && !pathname.startsWith("/api/editor/strings/")) return null;
  if (pathname !== "/api/editor/strings") return { status: 404, body: { ok: false, error: "not found" } };
  try {
    if (method === "GET") return { status: 200, body: { ok: true, langs: listLangs(repoRoot), tables: readStrings(repoRoot) } };
    if (method === "PUT") return { status: 200, body: { ok: true, saved: saveStrings(repoRoot, jsonBodyField(body, "tables")) } };
    return { status: 404, body: { ok: false, error: "not found" } };
  } catch (err) {
    return failureReply(err);
  }
}
