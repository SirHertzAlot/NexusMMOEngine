/**
 * Dungeon pool for the editor dev host (ROADMAP E8).
 *
 * The baked pool lives in `<dataDir>/dungeons` (`npm run dungeon:bake`:
 * index.json, `<id>.dungeon.json`, `<id>.png` maps, `<id>.shell.pcgm`).
 * Routes (wired in host.ts, loopback only like the rest):
 *
 *   GET  /api/editor/dungeons              → the pool: index entries, with
 *        whether each has a map and how many patch edits it carries
 *   GET  /api/editor/dungeons/<id>         → the baked file and its patch
 *   GET  /api/editor/dungeons/<id>/map.png → the bake's top-down map
 *   PUT  /api/editor/dungeons/<id>/patch   → {patch}: validated against the
 *        layout (inspectors/dungeon-view.ts validatePatch), then written to
 *        `<id>.patch.json`; an empty patch deletes the file
 *   POST /api/editor/dungeons/bake         → {count, seed?, theme?, rank?}:
 *        bake more into the pool (npm run dungeon:bake, the same CLI)
 *
 * Baked files are never written. An id must be one the index lists (and
 * look like `<theme>-<12 hex>`), so no path is ever taken from a request.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_DRESSING } from "@mmo-engine/dungeon";
import { countEdits, validatePatch, type DungeonFileView, type DungeonPatch } from "./inspectors/dungeon-view.js";

const ID = /^[a-z][a-z0-9]*-[0-9a-f]{12}$/;

export interface PoolEntry {
  id: string;
  name: string;
  theme: string;
  rooms: number;
  rank?: number;
  boss?: string;
  dwellers?: number;
  floorTiles: number;
  width: number;
  height: number;
  map: boolean;
  edits: number;
  /** A patch is there but its hash no longer matches the layout. */
  stale: boolean;
}

export function dungeonDir(dataDir: string): string {
  return join(dataDir, "dungeons");
}

interface IndexFile {
  dungeons: Array<{ id: string; file: string; hash: string; name: string; theme: string; rooms: number; rank?: number; boss?: string; dwellers?: number; floorTiles: number; width: number; height: number }>;
}

function readPoolIndex(dataDir: string): IndexFile {
  const file = join(dungeonDir(dataDir), "index.json");
  if (!existsSync(file)) return { dungeons: [] };
  return JSON.parse(readFileSync(file, "utf8")) as IndexFile;
}

/** The index entry for `id`; throws { status: 404 } for anything the index doesn't list. */
function entryFor(dataDir: string, id: string): IndexFile["dungeons"][number] {
  const e = ID.test(id) ? readPoolIndex(dataDir).dungeons.find((d) => d.id === id) : undefined;
  if (!e) throw Object.assign(new Error(`no dungeon ${id} in the pool`), { status: 404 });
  return e;
}

function readPatch(dataDir: string, id: string): DungeonPatch | null {
  const file = join(dungeonDir(dataDir), `${id}.patch.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as DungeonPatch) : null;
}

export function listPool(dataDir: string): PoolEntry[] {
  return readPoolIndex(dataDir).dungeons.map((d) => {
    const patch = readPatch(dataDir, d.id);
    return {
      id: d.id,
      name: d.name,
      theme: d.theme,
      rooms: d.rooms,
      ...(d.rank !== undefined ? { rank: d.rank } : {}),
      ...(d.boss ? { boss: d.boss } : {}),
      ...(d.dwellers !== undefined ? { dwellers: d.dwellers } : {}),
      floorTiles: d.floorTiles,
      width: d.width,
      height: d.height,
      map: existsSync(join(dungeonDir(dataDir), `${d.id}.png`)),
      edits: patch ? countEdits(patch) : 0,
      stale: patch !== null && patch.hash !== d.hash,
    };
  });
}

export function readDungeon(dataDir: string, id: string): { dungeon: DungeonFileView; patch: DungeonPatch | null } {
  const e = entryFor(dataDir, id);
  const dungeon = JSON.parse(readFileSync(join(dungeonDir(dataDir), e.file), "utf8")) as DungeonFileView;
  return { dungeon, patch: readPatch(dataDir, id) };
}

export function mapPng(dataDir: string, id: string): Buffer {
  entryFor(dataDir, id);
  const file = join(dungeonDir(dataDir), `${id}.png`);
  if (!existsSync(file)) throw Object.assign(new Error(`no map for ${id} (bake with --png)`), { status: 404 });
  return readFileSync(file);
}

/** The dressing's room archetypes (what a room's archetype may be set to). */
export const ARCHETYPES: readonly string[] = Object.keys(BUILTIN_DRESSING.archetypes);

/** Validate and write the patch; an empty one removes the file. Throws { status: 422, issues }. */
export function savePatch(dataDir: string, id: string, patch: unknown): { edits: number } {
  const { dungeon } = readDungeon(dataDir, id);
  const issues = validatePatch(dungeon, patch, ARCHETYPES);
  if (issues.length) throw Object.assign(new Error(`${id}: ${issues.length} issue(s); not saved`), { status: 422, issues });
  const p = patch as DungeonPatch;
  const file = join(dungeonDir(dataDir), `${id}.patch.json`);
  const edits = countEdits(p);
  if (edits === 0) rmSync(file, { force: true });
  else writeFileSync(file, JSON.stringify(p, null, 2) + "\n");
  return { edits };
}

export interface BakeRequest {
  count: number;
  seed?: number | "random";
  theme?: string;
  rank?: number;
}

/** The CLI arguments for a bake request; throws { status: 400 } on a bad one. */
export function bakeArgs(req: Partial<BakeRequest>): string[] {
  const bad = (m: string): never => {
    throw Object.assign(new Error(m), { status: 400 });
  };
  const count = req.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 50) bad("count must be a whole number 1–50");
  const args = ["--n", String(count), "--png"];
  if (req.seed !== undefined) {
    if (req.seed !== "random" && (!Number.isInteger(req.seed) || req.seed < 0 || req.seed > 0xffffffff)) bad("seed must be a u32 or \"random\"");
    args.push("--seed", String(req.seed));
  }
  if (req.theme !== undefined && req.theme !== "auto") {
    if (!/^[a-z][a-z0-9-]*$/.test(req.theme)) bad("bad theme id");
    args.push("--theme", req.theme);
  }
  if (req.rank !== undefined) {
    if (!Number.isInteger(req.rank) || req.rank < 1 || req.rank > 10) bad("rank must be a whole number 1–10");
    args.push("--rank", String(req.rank));
  }
  return args;
}

/** Bake into the pool with the dungeon package's CLI; resolves with its last lines. */
export function runBake(repoRoot: string, dataDir: string, req: Partial<BakeRequest>): Promise<{ log: string }> {
  const args = bakeArgs(req);
  const cli = join(repoRoot, "packages", "dungeon", "dist", "src", "cli.js");
  if (!existsSync(cli)) return Promise.reject(new Error("dungeon baker not built: run npm run build --workspace=@mmo-engine/dungeon"));
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      env: { ...process.env, MMO_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error("dungeon bake timed out"));
    }, 300_000);
    timer.unref?.();
    child.on("error", (e) => {
      clearTimeout(timer);
      rejectRun(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const log = out.trim().split("\n").slice(-12).join("\n");
      if (code === 0) resolveRun({ log });
      else rejectRun(Object.assign(new Error(log || `dungeon bake failed (exit ${code})`), { status: 400 }));
    });
  });
}
