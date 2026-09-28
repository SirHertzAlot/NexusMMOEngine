/**
 * World catalog — the world-level index in SurrealDB (embedded engine,
 * `@surrealdb/node`), shared by region servers and the world server:
 *
 *   world:<name>          size, seed, chunk size, region grid
 *   region:[rx, rz]       the chunk range one region server owns
 *   biome_region:<i>      a biome region's type and centre
 *   chunk:[cx, cz]        region, biome, height range, river flag
 *
 * Heights themselves stay in each region's world.db (hot data next to the
 * simulation); this catalog answers world-level questions — which region
 * owns a chunk, where the deserts are — without touching tiles.
 *
 * Verified on Windows: `rocksdb` works; `surrealkv` hangs. The engine's URL
 * parsing mangles paths: "rocksdb://C:/x" writes to a folder "C" under the
 * working directory, and relative paths with ".." resolve elsewhere. The
 * form that lands where intended is "rocksdb:" + an absolute path with
 * forward slashes and no "//" (see rocksdbUrl).
 */

import * as path from "node:path";
import { Surreal } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";

export interface CatalogChunk {
  cx: number;
  cz: number;
  region: [number, number];
  biome: string;
  minHeight: number;
  maxHeight: number;
  river: boolean;
}

export interface CatalogRegion {
  rx: number;
  rz: number;
  /** Inclusive chunk range this region owns. */
  chunks: { x0: number; z0: number; x1: number; z1: number };
}

export interface WorldCatalog {
  world: { name: string; seed: number; sizeChunks: number; chunkWorldSize: number; regionsPerSide: number };
  regions: CatalogRegion[];
  biomeRegions: Array<{ index: number; biome: string; x: number; z: number }>;
  chunks: CatalogChunk[];
}

const BATCH = 5000;

/** RocksDB storage URL for a directory: "rocksdb:" + absolute path (see header). */
export function rocksdbUrl(dir: string): string {
  return `rocksdb:${path.resolve(dir).split(path.sep).join("/")}`;
}

/**
 * One connection per store per process. The embedded engine keeps a store
 * locked after close() — reopening it in the same process hangs — and an
 * open connection keeps Node running. So connections are shared, stay open,
 * and closeWorldCatalogs() closes them all when the process is done.
 */
const connections = new Map<string, Promise<Surreal>>();
const closed = new Set<string>();

async function open(url: string): Promise<Surreal> {
  const db = new Surreal({ engines: createNodeEngines() });
  // An unusable storage URL can hang forever instead of failing (seen with
  // surrealkv:// on Windows): bound it.
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db.connect(url),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`world catalog: connecting to ${url} timed out`)), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  await db.use({ namespace: "mmo", database: "world" });
  return db;
}

function connect(url: string): Promise<Surreal> {
  if (closed.has(url)) {
    return Promise.reject(
      new Error(`world catalog: ${url} was closed in this process, and the embedded engine can't reopen it`),
    );
  }
  let db = connections.get(url);
  if (!db) {
    db = open(url);
    connections.set(url, db);
    db.catch(() => connections.delete(url));
  }
  return db;
}

/** Close every catalog connection (at shutdown: a closed store can't be reopened in this process). */
export async function closeWorldCatalogs(): Promise<void> {
  const open = [...connections];
  connections.clear();
  for (const [url, db] of open) {
    closed.add(url);
    try {
      await (await db).close();
    } catch {
      // never opened: nothing to close
    }
  }
}

const TABLES = ["world", "region", "biome_region", "chunk"];

/** Replace the catalog with `catalog` (a rebake rewrites it wholesale). */
export async function writeWorldCatalog(url: string, catalog: WorldCatalog): Promise<void> {
  const db = await connect(url);
  // SurrealDB 3 rejects DELETE on a table that doesn't exist yet.
  await db.query(TABLES.map((t) => `DEFINE TABLE IF NOT EXISTS ${t} SCHEMALESS; DELETE ${t};`).join(" "));
  await db.query("CREATE type::record('world', $name) CONTENT $world", {
    name: catalog.world.name,
    world: catalog.world,
  });
  await db.query("INSERT INTO region $rows", {
    rows: catalog.regions.map((r) => ({ id: [r.rx, r.rz], ...r })),
  });
  await db.query("INSERT INTO biome_region $rows", {
    rows: catalog.biomeRegions.map((b) => ({ id: b.index, ...b })),
  });
  for (let i = 0; i < catalog.chunks.length; i += BATCH) {
    await db.query("INSERT INTO chunk $rows", {
      rows: catalog.chunks.slice(i, i + BATCH).map((c) => ({ id: [c.cx, c.cz], ...c })),
    });
  }
}

/** Read helpers for tools and tests (the connection stays open: see closeWorldCatalogs). */
export async function readCatalogSummary(url: string): Promise<{
  chunks: number;
  regions: number;
  biomes: Record<string, number>;
  chunk: (cx: number, cz: number) => Promise<CatalogChunk | null>;
}> {
  const db = await connect(url);
  const [[chunks]] = await db.query<[[{ n: number }]]>("SELECT count() AS n FROM chunk GROUP ALL");
  const [[regions]] = await db.query<[[{ n: number }]]>("SELECT count() AS n FROM region GROUP ALL");
  const [biomeRows] = await db.query<[Array<{ biome: string; n: number }>]>(
    "SELECT biome, count() AS n FROM chunk GROUP BY biome",
  );
  return {
    chunks: chunks?.n ?? 0,
    regions: regions?.n ?? 0,
    biomes: Object.fromEntries(biomeRows.map((r) => [r.biome, r.n])),
    chunk: async (cx, cz) => {
      const [[row]] = await db.query<[[CatalogChunk | undefined]]>(
        "SELECT cx, cz, region, biome, minHeight, maxHeight, river FROM type::record('chunk', [$cx, $cz])",
        { cx, cz },
      );
      return row ?? null;
    },
  };
}
