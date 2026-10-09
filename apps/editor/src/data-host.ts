/**
 * The data files behind the newer Gameplay grids (roadmap: data-driven
 * entities), beside gameplay-host.ts which delegates here:
 *
 *   refining, reagents  content/crafting/recipes.json  (the crafting rules the server and `craft:report` read)
 *   prefabs             content/prefabs/<name>.prefab.json  (component bundles scenes place)
 *
 * Same posture as the rest of the host: table names are whitelisted (never a
 * path), every candidate goes through the loaders the game itself uses
 * (`checkCraftingRules`, `validatePrefab` + `expandPrefabs`), a refused save
 * answers with every issue and writes nothing, and writes are atomic.
 *
 * `refining` and `reagents` are two views of one file: a save replaces only
 * its own section of what is on disk, so saving one never undoes the other.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { expandPrefabs, NODE_KINDS, PREFAB_NAME_RE, validatePrefab, type PrefabDoc, type SceneDoc } from "@mmo-engine/scene";
import { readRuleFile } from "./rules-host.js";
import { listScenes, readScene } from "./scenes-host.js";

export const DATA_TABLES = ["refining", "reagents", "prefabs"] as const;
export type DataTable = (typeof DATA_TABLES)[number];
export const isDataTable = (v: unknown): v is DataTable => typeof v === "string" && (DATA_TABLES as readonly string[]).includes(v);

export interface DataIssue {
  file: string;
  path: string;
  message: string;
}

interface CraftingModule {
  BUILTIN_MATERIALS: Record<string, unknown>;
  checkCraftingRules(json: unknown): Array<{ path: string; message: string }>;
}
const craftingModules = new Map<string, Promise<CraftingModule>>();

/** The built @mmo-engine/crafting (loaded from dist, never bundled into Vite). */
function loadCraftingModule(repoRoot: string): Promise<CraftingModule> {
  let p = craftingModules.get(repoRoot);
  if (!p) {
    p = import(pathToFileURL(join(repoRoot, "packages", "crafting", "dist", "src", "index.js")).href).then(
      (m) => m as CraftingModule,
      (e: unknown) => {
        craftingModules.delete(repoRoot);
        throw Object.assign(new Error(`the crafting rules loader isn't built (npm run build -w @mmo-engine/crafting): ${(e as Error).message}`), { status: 500 });
      },
    );
    craftingModules.set(repoRoot, p);
  }
  return p;
}

const recipesFile = (repoRoot: string): string => join(repoRoot, "content", "crafting", "recipes.json");
const prefabsDir = (repoRoot: string): string => join(repoRoot, "content", "prefabs");
const prefabFile = (repoRoot: string, name: string): string => join(prefabsDir(repoRoot), `${name}.prefab.json`);

const readJson = (file: string): unknown => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as unknown) : undefined);

function writeAtomic(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

const oneLine = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(oneLine).join(", ")}]`;
  if (v !== null && typeof v === "object") {
    const e = Object.entries(v);
    return e.length === 0 ? "{}" : `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${oneLine(x)}`).join(", ")} }`;
  }
  return JSON.stringify(v);
};

/** JSON the way the repo's content is written: the top level spread out, short values on one line. */
export function prettyJson(v: unknown, indent = ""): string {
  if (v === null || typeof v !== "object" || (indent !== "" && oneLine(v).length <= 100)) return oneLine(v);
  const next = `${indent}  `;
  if (Array.isArray(v)) return v.length === 0 ? "[]" : `[\n${v.map((x) => next + prettyJson(x, next)).join(",\n")}\n${indent}]`;
  const entries = Object.entries(v);
  return entries.length === 0 ? "{}" : `{\n${entries.map(([k, x]) => `${next}${JSON.stringify(k)}: ${prettyJson(x, next)}`).join(",\n")}\n${indent}}`;
}

// ------------------------------------------------------------------ read

export interface DataSnapshot {
  tables: Record<DataTable, unknown>;
  refs: { materials: string[]; prefabs: string[] };
  options: { nodeKinds: string[]; lootTables: string[]; materials: string[] };
}

export function readPrefabs(repoRoot: string): Record<string, PrefabDoc> {
  const out: Record<string, PrefabDoc> = {};
  const dir = prefabsDir(repoRoot);
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".prefab.json")).sort()) {
    try {
      out[f.slice(0, -".prefab.json".length)] = JSON.parse(readFileSync(join(dir, f), "utf8")) as PrefabDoc;
    } catch {
      /* an unreadable file isn't listed; the server refuses to boot on it and says which */
    }
  }
  return out;
}

export async function readDataTables(repoRoot: string): Promise<DataSnapshot> {
  const recipes = readJson(recipesFile(repoRoot)) ?? {};
  const prefabs = readPrefabs(repoRoot);
  const rows = Object.fromEntries(
    Object.entries(prefabs).map(([name, { version: _v, name: _n, ...rest }]) => [name, rest]),
  );
  let materials: string[] = [];
  try {
    materials = Object.keys((await loadCraftingModule(repoRoot)).BUILTIN_MATERIALS);
  } catch {
    /* the crafting grids then show every material as unknown until it is built */
  }
  const loot = (readRuleFile(repoRoot, "loot").content as { tables?: Record<string, unknown> }).tables ?? {};
  return {
    tables: { refining: recipes, reagents: recipes, prefabs: { prefabs: rows } },
    refs: { materials, prefabs: Object.keys(prefabs) },
    options: { nodeKinds: [...NODE_KINDS], lootTables: Object.keys(loot), materials },
  };
}

// ----------------------------------------------------------------- usage

function* nodesOf(list: unknown): Generator<Record<string, unknown>> {
  if (!Array.isArray(list)) return;
  for (const n of list) {
    if (n === null || typeof n !== "object") continue;
    yield n as Record<string, unknown>;
    yield* nodesOf((n as { children?: unknown }).children);
  }
}

/** Does `ref` (a node's `prefab`) name prefab `name`? Whole string, else the last path segment. */
const names = (ref: unknown, name: string, all: ReadonlySet<string>): boolean =>
  typeof ref === "string" && (ref === name || (!all.has(ref) && ref.split("/").pop() === name));

/** Scenes and other prefabs that place prefab `name`. */
export function prefabUsers(repoRoot: string, name: string, existing: ReadonlySet<string>): string[] {
  const users: string[] = [];
  for (const s of listScenes(repoRoot)) {
    try {
      const doc = readScene(repoRoot, s) as { nodes?: unknown };
      for (const n of nodesOf(doc.nodes)) if (names(n.prefab, name, existing)) { users.push(`content/scenes/${s}.scene.json`); break; }
    } catch {
      /* the Scenes workspace reports an unreadable scene */
    }
  }
  for (const [other, p] of Object.entries(readPrefabs(repoRoot))) {
    if (other === name) continue;
    for (const n of nodesOf(p.children)) if (names(n.prefab, name, existing)) { users.push(`content/prefabs/${other}.prefab.json`); break; }
  }
  return users;
}

// ----------------------------------------------------------------- check

interface Candidate {
  issues: DataIssue[];
  /** What a save would write: file -> text (null: delete). Empty when there are issues or nothing changed. */
  writes: Map<string, string | null>;
}

async function craftingCandidate(repoRoot: string, table: "refining" | "reagents", content: unknown): Promise<Candidate> {
  const file = "recipes.json";
  const bad = (path: string, message: string): Candidate => ({ issues: [{ file, path, message }], writes: new Map() });
  const section = (content as Record<string, unknown> | null)?.[table];
  if (section === null || typeof section !== "object" || Array.isArray(section)) return bad(table, "must be an object");
  const disk = (readJson(recipesFile(repoRoot)) ?? {}) as Record<string, unknown>;
  const candidate = { ...disk, [table]: section };
  const issues = (await loadCraftingModule(repoRoot)).checkCraftingRules(candidate).map((i) => ({ file, path: i.path, message: i.message }));
  const writes = new Map<string, string | null>();
  if (issues.length === 0 && !isDeepStrictEqual(candidate, disk)) writes.set(recipesFile(repoRoot), `${prettyJson(candidate)}\n`);
  return { issues, writes };
}

function prefabsCandidate(repoRoot: string, content: unknown): Candidate {
  const bad = (name: string, path: string, message: string): DataIssue => ({ file: `${name}.prefab.json`, path: `prefabs.${name}${path ? `.${path}` : ""}`, message });
  const rows = (content as { prefabs?: Record<string, Record<string, unknown>> } | null)?.prefabs;
  if (rows === undefined || rows === null || typeof rows !== "object" || Array.isArray(rows)) {
    return { issues: [{ file: "prefabs", path: "prefabs", message: 'need {"prefabs": {…}}' }], writes: new Map() };
  }
  const issues: DataIssue[] = [];
  const docs: Record<string, PrefabDoc> = {};
  const creatures = new Set(Object.keys(((readRuleFile(repoRoot, "creatures").content as { creatures?: object }).creatures ?? {}) as object));
  for (const [name, row] of Object.entries(rows)) {
    if (!PREFAB_NAME_RE.test(name)) issues.push(bad(name, "", "the name must be lowercase letters, digits and dashes"));
    const doc = { version: 1, name, ...row } as PrefabDoc;
    for (const i of validatePrefab(doc)) if (i.path !== "name" || PREFAB_NAME_RE.test(name)) issues.push(bad(name, i.path, i.message));
    if (creatures.has(name)) issues.push(bad(name, "", `"${name}" is a creature: scenes naming it would stop spawning the creature`));
    docs[name] = doc;
  }
  // Prefabs placing prefabs must not loop.
  if (issues.length === 0) {
    const probe: SceneDoc = { version: 1, name: "probe", kind: "world", nodes: Object.keys(docs).map((n) => ({ id: n, prefab: n })) };
    for (const p of expandPrefabs(probe, docs).problems) issues.push(bad(p.split(":")[0], "children", p.slice(p.indexOf(":") + 2)));
  }
  // A prefab a scene or another prefab places can't be removed.
  const existing = readPrefabs(repoRoot);
  const keep = new Set(Object.keys(docs));
  for (const name of Object.keys(existing)) {
    if (keep.has(name)) continue;
    const users = prefabUsers(repoRoot, name, new Set(Object.keys(existing)));
    if (users.length > 0) issues.push(bad(name, "", `prefab "${name}" can't be removed: ${users.join(", ")} still place it`));
  }
  const writes = new Map<string, string | null>();
  if (issues.length === 0) {
    for (const [name, doc] of Object.entries(docs)) if (!isDeepStrictEqual(doc, existing[name])) writes.set(prefabFile(repoRoot, name), `${prettyJson(doc)}\n`);
    for (const name of Object.keys(existing)) if (!keep.has(name)) writes.set(prefabFile(repoRoot, name), null);
  }
  return { issues, writes };
}

async function candidate(repoRoot: string, table: DataTable, content: unknown): Promise<Candidate> {
  return table === "prefabs" ? prefabsCandidate(repoRoot, content) : craftingCandidate(repoRoot, table, content);
}

/** Every issue the game's loaders would raise for `content` as `table`. Nothing is written. */
export async function checkDataTable(repoRoot: string, table: DataTable, content: unknown): Promise<DataIssue[]> {
  return (await candidate(repoRoot, table, content)).issues;
}

/** Validate, then write. Throws { status: 400, issues } (and writes nothing) when the game would refuse it. */
export async function saveDataTable(repoRoot: string, table: DataTable, content: unknown): Promise<void> {
  const { issues, writes } = await candidate(repoRoot, table, content);
  if (issues.length > 0) {
    throw Object.assign(new Error(`invalid ${table}: ${issues.length} problem${issues.length === 1 ? "" : "s"}`), { status: 400, issues });
  }
  for (const [file, text] of writes) {
    if (text === null) rmSync(file, { force: true });
    else writeAtomic(file, text);
  }
}
