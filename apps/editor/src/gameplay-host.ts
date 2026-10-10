/**
 * Gameplay grid storage for the editor dev host (roadmap EA15).
 *
 * Loopback routes (wired in host.ts), same posture as rules-host.ts:
 *
 *   GET  /api/editor/gameplay        -> { tables, context }  every grid's file plus what references check against
 *   POST /api/editor/gameplay/check  -> { table, content } -> { issues }, nothing written
 *   PUT  /api/editor/gameplay/:table -> { content } -> validate, then write
 *
 * - The table name is whitelisted (GAMEPLAY_TABLES), never a path; the files
 *   are content/rules/<table>.json (written through rules-host, so the server's
 *   own `parseRules` has the last word) and content/species/species.json.
 * - Beyond the loader, a save is refused when it removes a creature or an item
 *   base that a scene or a quest still uses.
 * - A refused save answers 400 with every issue (file, path, message) and
 *   writes nothing. The mutating routes demand a JSON content type.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { checkRuleSave, readRuleFile, rulesDir, saveRuleFile } from "./rules-host.js";
import { readRulesTables } from "./rules-store.js";
import { isGameplayTable, type GameplayTable } from "./gameplay-tables.js";
import { refuseInvalid } from "./api.js";

export interface GameplayIssue {
  file: string;
  path: string;
  message: string;
}

export interface GameplayContext {
  refs: { items: string[]; creatures: string[] };
  options: { techniques: string[]; families: string[] };
  /** Species the engine ships: they can be overridden, not removed. */
  builtinSpecies: string[];
}

export interface GameplaySnapshot {
  tables: Record<GameplayTable, unknown>;
  context: GameplayContext;
}

type Roster = Record<string, unknown>;
export interface SpeciesModule {
  BUILTIN_SPECIES: Roster;
  loadSpecies(file?: string): Roster;
}

const speciesModules = new Map<string, Promise<SpeciesModule>>();

/** The server-side species loader, from the built @mmo-engine/species (never bundled into Vite). */
export function loadSpeciesModule(repoRoot: string): Promise<SpeciesModule> {
  let p = speciesModules.get(repoRoot);
  if (!p) {
    const file = join(repoRoot, "packages", "species", "dist", "src", "index.js");
    p = import(pathToFileURL(file).href).then(
      (m) => m as SpeciesModule,
      (e: unknown) => {
        speciesModules.delete(repoRoot);
        throw Object.assign(new Error(`the species loader isn't built (npm run build -w @mmo-engine/species): ${(e as Error).message}`), { status: 500 });
      },
    );
    speciesModules.set(repoRoot, p);
  }
  return p;
}

const speciesFile = (repoRoot: string): string => join(repoRoot, "content", "species", "species.json");

// ------------------------------------------------------------------ read

export async function readGameplay(repoRoot: string): Promise<GameplaySnapshot> {
  const dir = rulesDir(repoRoot);
  const { tables: rt, techniques } = readRulesTables(dir);
  const skills = readRuleFile(repoRoot, "skills").content as { families?: string[] };
  const keys = (v: unknown, under: string): string[] => Object.keys(((v as Record<string, unknown>)[under] ?? {}) as object);
  const sp = await loadSpeciesModule(repoRoot);
  const file = speciesFile(repoRoot);
  const roster = existsSync(file) ? sp.loadSpecies(file) : sp.BUILTIN_SPECIES;
  return {
    tables: {
      creatures: rt.creatures,
      items: rt.items,
      skills: readRuleFile(repoRoot, "skills").content,
      spells: readRuleFile(repoRoot, "spells").content,
      species: { species: roster },
    },
    context: {
      refs: { items: keys(rt.items, "bases"), creatures: keys(rt.creatures, "creatures") },
      options: { techniques, families: skills.families ?? [] },
      builtinSpecies: Object.keys(sp.BUILTIN_SPECIES),
    },
  };
}

// ----------------------------------------------------------------- usage

/** Where scenes and quests use creatures and item bases: id -> files. */
export function findUsages(repoRoot: string): { creatures: Map<string, string[]>; items: Map<string, string[]> } {
  const out = { creatures: new Map<string, string[]>(), items: new Map<string, string[]>() };
  const add = (m: Map<string, string[]>, id: string, where: string): void => {
    const at = m.get(id) ?? [];
    if (!at.includes(where)) at.push(where);
    m.set(id, at);
  };
  const walk = (v: unknown, where: string, quests: boolean): void => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, where, quests));
    if (v === null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const spawner = (o.components as Record<string, { creature?: unknown }> | undefined)?.Spawner;
    if (typeof spawner?.creature === "string" && spawner.creature) add(out.creatures, spawner.creature, where);
    if (typeof o.fallbackCreature === "string") add(out.creatures, o.fallbackCreature, where);
    if (quests) {
      if (o.type === "kill" && typeof o.kind === "string") add(out.creatures, o.kind, where);
      if (typeof o.base === "string") add(out.items, o.base, where);
    }
    for (const x of Object.values(o)) walk(x, where, quests);
  };
  const scan = (dir: string, rel: string, test: (f: string) => boolean, quests: boolean): void => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter(test).sort()) {
      try {
        walk(JSON.parse(readFileSync(join(dir, f), "utf8")), `${rel}/${f}`, quests);
      } catch {
        /* an unreadable file isn't a reference; its own editor reports it */
      }
    }
  };
  scan(join(repoRoot, "content", "scenes"), "content/scenes", (f) => f.endsWith(".scene.json"), false);
  scan(join(repoRoot, "content", "dungeons"), "content/dungeons", (f) => f.endsWith(".json"), false);
  scan(join(repoRoot, "content", "quests"), "content/quests", (f) => f.endsWith(".json"), true);
  return out;
}

function removalIssues(repoRoot: string, table: "creatures" | "items", content: unknown): GameplayIssue[] {
  const under = table === "creatures" ? "creatures" : "bases";
  const now = new Set(Object.keys(((content as Record<string, unknown> | null)?.[under] ?? {}) as object));
  const was = Object.keys(((readRuleFile(repoRoot, table).content as Record<string, unknown>)[under] ?? {}) as object);
  const used = findUsages(repoRoot)[table];
  const noun = table === "creatures" ? "creature" : "item base";
  return was
    .filter((id) => !now.has(id) && used.has(id))
    .map((id) => ({ file: `${table}.json`, path: `${under}.${id}`, message: `${noun} "${id}" can't be removed: ${used.get(id)!.join(", ")} still use it` }));
}

// ----------------------------------------------------------------- check

/** Every issue the server's loaders (and the removal rule) would raise for `content` as `table`. Nothing is written. */
export async function checkGameplay(repoRoot: string, table: GameplayTable, content: unknown): Promise<GameplayIssue[]> {
  if (table === "species") return (await speciesOverlay(repoRoot, content)).issues;
  const issues: GameplayIssue[] = checkRuleSave(repoRoot, table, content);
  if (table === "creatures" || table === "items") issues.push(...removalIssues(repoRoot, table, content));
  return issues;
}

/** The overlay file for a species grid (only rows that differ from the built-in roster), and its problems. */
async function speciesOverlay(repoRoot: string, content: unknown): Promise<{ overlay: Roster; issues: GameplayIssue[] }> {
  const sp = await loadSpeciesModule(repoRoot);
  const rows = ((content as { species?: Roster } | null)?.species ?? null) as Roster | null;
  const bad = (path: string, message: string): GameplayIssue => ({ file: "species.json", path, message });
  if (rows === null || typeof rows !== "object" || Array.isArray(rows)) return { overlay: {}, issues: [bad("", 'need {"species": {…}}')] };
  const issues: GameplayIssue[] = [];
  for (const id of Object.keys(sp.BUILTIN_SPECIES)) {
    if (!(id in rows)) issues.push(bad(`species.${id}`, `"${id}" is built in: it can be overridden, not removed`));
  }
  const overlay: Roster = {};
  for (const [id, row] of Object.entries(rows)) if (!isDeepStrictEqual(row, sp.BUILTIN_SPECIES[id])) overlay[id] = row;
  // The real loader reads a file: give it the candidate in a throwaway one.
  const tmp = mkdtempSync(join(tmpdir(), "mmo-species-"));
  try {
    const file = join(tmp, "species.json");
    writeFileSync(file, JSON.stringify(overlay));
    try {
      sp.loadSpecies(file);
    } catch (e) {
      for (const line of (e as Error).message.split("\n").slice(1)) {
        const m = /^\s+([^:]*): (.*)$/.exec(line);
        issues.push(m ? bad(`species.${m[1]}`, m[2]) : bad("", line.trim()));
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { overlay, issues };
}

// ------------------------------------------------------------------ save

/** Validate, then write. Throws { status: 400, issues } (and writes nothing) when the server would refuse it. */
export async function saveGameplay(repoRoot: string, table: GameplayTable, content: unknown): Promise<void> {
  const fail = (issues: GameplayIssue[]): never => {
    throw refuseInvalid(table, issues);
  };
  if (table === "species") {
    const { overlay, issues } = await speciesOverlay(repoRoot, content);
    if (issues.length > 0) fail(issues);
    const file = speciesFile(repoRoot);
    if (!existsSync(file) && Object.keys(overlay).length === 0) return;
    mkdirSync(join(repoRoot, "content", "species"), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(overlay, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
    return;
  }
  const issues = await checkGameplay(repoRoot, table, content);
  if (issues.length > 0) fail(issues);
  saveRuleFile(repoRoot, table, content);
}

// ---------------------------------------------------------------- routes

export interface GameplayRequest {
  method: string;
  /** Path after /api/editor/gameplay/ ("" for the snapshot). */
  route: string;
  contentType?: string;
  body: unknown;
}

export async function handleGameplay(repoRoot: string, req: GameplayRequest): Promise<{ status: number; body: unknown }> {
  const obj = (req.body ?? {}) as Record<string, unknown>;
  const no = (status: number, error: string): { status: number; body: unknown } => ({ status, body: { ok: false, error } });
  try {
    if (req.method === "GET" && req.route === "") return { status: 200, body: { ok: true, ...(await readGameplay(repoRoot)) } };
    if (req.method !== "POST" && req.method !== "PUT") return no(404, "not found");
    if (!/^application\/json\b/i.test(req.contentType ?? "")) return no(415, "send application/json");
    if (req.method === "POST" && req.route === "check") {
      if (!isGameplayTable(obj.table)) return no(400, `unknown table "${String(obj.table)}"`);
      return { status: 200, body: { ok: true, issues: await checkGameplay(repoRoot, obj.table, obj.content) } };
    }
    if (req.method === "PUT" && isGameplayTable(req.route)) {
      if (!("content" in obj)) return no(400, 'need a JSON body shaped like {"content": …}');
      await saveGameplay(repoRoot, req.route, obj.content);
      return { status: 200, body: { ok: true } };
    }
    return no(404, "not found");
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    const issues = (e as { issues?: unknown }).issues;
    return { status, body: { ok: false, error: e instanceof Error ? e.message : String(e), ...(Array.isArray(issues) ? { issues } : {}) } };
  }
}
