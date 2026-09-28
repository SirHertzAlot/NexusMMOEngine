/**
 * terrain-tool — offline access to the world heightmap, for the editor.
 *
 *   node dist/src/terrain-tool.js export [< area]    an area's tiles + props -> stdout
 *   node dist/src/terrain-tool.js generate < req     generator preview (not saved)
 *   node dist/src/terrain-tool.js import < tiles     save edited tiles
 *
 * A baked world is too big to edit whole (a 4 km world is 62,500 tiles),
 * so export returns one area - {cx, cz, radius} in chunks, default 8
 * around (0,0) - and import reads only the edited tiles' neighbourhood.
 *
 * Env: MMO_DATA_DIR (./data), MMO_WORLD_SEED (1234), MMO_CHUNK_SIZE (16),
 *      MMO_WORLD_RADIUS (1), MMO_TERRAIN_AMPLITUDE / MMO_TERRAIN_FREQUENCY.
 *
 * I/O is one JSON object on stdin/stdout; failures print a message on
 * stderr and exit 1. It runs as its own process (spawned by the editor
 * host, like seed-user) so native code never loads into the editor.
 *
 * import is the only writer, and it:
 *  - refuses while a server owns the data dir (its next periodic save
 *    would silently overwrite the edit);
 *  - rejects tiles outside the baked world, and tiles that open a seam
 *    against their stored neighbours;
 *  - moves every prop standing in an edited chunk by the ground change
 *    under it, so trees stay planted on sculpted terrain — props in the
 *    snapshot (loaded chunks) and in the rows of unloaded chunks alike;
 *  - writes tiles and the corrected snapshot in ONE transaction.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  chunkKey,
  HeightGrid,
  type CollectedState,
  type TerrainTile,
} from "@mmo-engine/protocol";
import {
  ChunkEntityStore,
  decodeSnapshot,
  encodeSnapshot,
  makeProcgenChunkSource,
  runningServerPid,
  SnapshotStore,
  terrainHeightAt,
  terrainOptionsFromEnv,
  TerrainTileStore,
  chunkCoordsFor,
} from "./index.js";

const DATA_DIR = path.resolve(process.env.MMO_DATA_DIR ?? "./data");
const DB_PATH = path.join(DATA_DIR, "world.db");
const WORLD_SEED = BigInt(process.env.MMO_WORLD_SEED ?? 1234);
const CHUNK_SIZE = Number(process.env.MMO_CHUNK_SIZE ?? 16);
const WORLD_RADIUS = Number(process.env.MMO_WORLD_RADIUS ?? 1);

interface WireTile {
  cx: number;
  cz: number;
  heights: number[];
}

/** Largest area the editor loads at once: (2*32+1)^2 = 4225 chunks. */
const MAX_AREA_RADIUS = 32;
const DEFAULT_AREA_RADIUS = 8;

interface Area {
  cx: number;
  cz: number;
  radius: number;
}

/** Inclusive chunk rectangle [cx0, cz0, cx1, cz1]. */
type ChunkRange = [number, number, number, number];

const areaRange = (a: Area): ChunkRange => [a.cx - a.radius, a.cz - a.radius, a.cx + a.radius, a.cz + a.radius];

const inRange = ([cx0, cz0, cx1, cz1]: ChunkRange, cx: number, cz: number): boolean =>
  cx >= cx0 && cx <= cx1 && cz >= cz0 && cz <= cz1;

function parseArea(input: string): Area {
  const req = (input.trim() ? JSON.parse(input) : {}) as Partial<Area>;
  const area = { cx: req.cx ?? 0, cz: req.cz ?? 0, radius: req.radius ?? DEFAULT_AREA_RADIUS };
  if (!Number.isInteger(area.cx) || !Number.isInteger(area.cz)) throw new Error("area centre must be integer chunk coords");
  if (!Number.isInteger(area.radius) || area.radius < 0 || area.radius > MAX_AREA_RADIUS) {
    throw new Error(`area radius must be a whole number of chunks, 0..${MAX_AREA_RADIUS}`);
  }
  return area;
}

/** The baked world's name, seed, and chunk range; null for a legacy (pre-spec) world. */
function bakedWorld(store: SnapshotStore): { name: string; seed: string; minChunk: number; maxChunk: number } | null {
  const bounds = store.getMeta("world_bounds");
  if (!bounds) return null;
  const { minChunk, maxChunk } = JSON.parse(bounds) as { minChunk: number; maxChunk: number };
  return {
    name: store.getMeta("world_spec") ?? "world",
    seed: store.getMeta("world_seed") ?? WORLD_SEED.toString(),
    minChunk,
    maxChunk,
  };
}

const toWire = (t: TerrainTile): WireTile => ({ cx: t.cx, cz: t.cz, heights: Array.from(t.heights) });

function fromWire(t: WireTile): TerrainTile {
  if (!t || !Array.isArray(t.heights)) throw new Error("each tile needs cx, cz, heights[]");
  return { cx: t.cx, cz: t.cz, heights: Float32Array.from(t.heights) };
}

function readStdin(): string {
  return fs.readFileSync(0, "utf8");
}

/** Chunk coords of every chunk entity in a decoded snapshot. */
function snapshotChunks(state: CollectedState): Array<[number, number]> {
  return state.chunks.map((c) => {
    const { cx, cz } = chunkCoordsFor(c.chunkId);
    return [cx, cz] as [number, number];
  });
}

/** Transforms that are props: not login avatars, not chunk entities. */
function propRows(state: CollectedState): CollectedState["transforms"] {
  const skip = new Set<bigint>([
    ...state.intents.map((r) => r.wireId),
    ...state.chunks.map((r) => r.wireId),
  ]);
  return state.transforms.filter((t) => !skip.has(t.wireId));
}

/**
 * Rows of the chunks in `range` that were unloaded when the snapshot was
 * taken (see ChunkEntityStore): a chunk loaded in the snapshot has its
 * props there, and its row (if any) is stale.
 */
function unloadedRows(
  rows: ChunkEntityStore,
  state: CollectedState | null,
  range: ChunkRange,
): Array<{ cx: number; cz: number; tick: number; state: CollectedState }> {
  const loaded = new Set((state ? snapshotChunks(state) : []).map(([cx, cz]) => chunkKey(cx, cz)));
  return rows
    .getRange(...range)
    .filter((r) => !loaded.has(chunkKey(r.cx, r.cz)))
    .map((r) => ({ cx: r.cx, cz: r.cz, tick: r.tick, state: decodeSnapshot(r.bytes) }));
}

/**
 * Shift each prop standing in an edited chunk by the change in ground
 * height under it (keeps any intentional offset). Returns how many moved.
 */
function reseat(
  props: CollectedState["transforms"],
  edited: Map<string, TerrainTile>,
  before: Map<string, TerrainTile>,
): number {
  let moved = 0;
  for (const row of props) {
    const cx = Math.floor(row.px / CHUNK_SIZE);
    const cz = Math.floor(row.pz / CHUNK_SIZE);
    const next = edited.get(chunkKey(cx, cz));
    const prev = before.get(chunkKey(cx, cz));
    if (!next || !prev) continue;
    const lx = row.px - cx * CHUNK_SIZE;
    const lz = row.pz - cz * CHUNK_SIZE;
    const dy =
      terrainHeightAt(next.heights, lx, lz, CHUNK_SIZE) -
      terrainHeightAt(prev.heights, lx, lz, CHUNK_SIZE);
    if (dy !== 0) {
      row.py += dy;
      moved++;
    }
  }
  return moved;
}

function generatedTiles(
  coords: Array<[number, number]>,
  opts = terrainOptionsFromEnv(),
): TerrainTile[] {
  const source = makeProcgenChunkSource(opts);
  return coords.map(([cx, cz]) => {
    const heights = new Float32Array(source.chunkSamples);
    source.generateChunk(WORLD_SEED, cx, cz, 0, heights);
    return { cx, cz, heights };
  });
}

function defaultArea(): Array<[number, number]> {
  const area: Array<[number, number]> = [];
  for (let cz = -WORLD_RADIUS; cz <= WORLD_RADIUS; cz++) {
    for (let cx = -WORLD_RADIUS; cx <= WORLD_RADIUS; cx++) area.push([cx, cz]);
  }
  return area;
}

interface WorldView {
  /** The world's terrain in the range: stored tiles, or generated if none stored yet. */
  tiles: TerrainTile[];
  stored: boolean;
  /** Stored tiles in the whole world. */
  total: number;
  snapshot: ReturnType<SnapshotStore["loadLatest"]>;
  state: CollectedState | null;
}

function openWorld(store: SnapshotStore, tileStore: TerrainTileStore, range: ChunkRange): WorldView {
  const snapshot = store.loadLatest();
  const state = snapshot ? decodeSnapshot(snapshot.bytes) : null;
  const total = tileStore.count();
  if (total > 0) return { tiles: tileStore.getRange(...range), stored: true, total, snapshot, state };
  // No tiles yet: a small legacy world baked before tiles were stored, or
  // no world at all. Show what the server would generate for it - all of
  // it, since the first save stores every tile.
  const coords = state && state.chunks.length > 0 ? snapshotChunks(state) : defaultArea();
  return { tiles: generatedTiles(coords), stored: false, total: 0, snapshot, state };
}

function cmdExport(): unknown {
  const area = parseArea(readStdin());
  const range = areaRange(area);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const store = new SnapshotStore({ dbPath: DB_PATH });
  const tileStore = new TerrainTileStore(DB_PATH);
  const rowStore = new ChunkEntityStore(DB_PATH);
  try {
    const world = openWorld(store, tileStore, range);
    const baked = bakedWorld(store);
    const opts = makeProcgenChunkSource(terrainOptionsFromEnv());
    const props = [
      ...(world.state ? propRows(world.state) : []),
      ...unloadedRows(rowStore, world.state, range).flatMap((r) => r.state.transforms),
    ].filter((t) => inRange(range, Math.floor(t.px / CHUNK_SIZE), Math.floor(t.pz / CHUNK_SIZE)));
    return {
      chunkWorldSize: CHUNK_SIZE,
      seed: baked?.seed ?? WORLD_SEED.toString(),
      stored: world.stored,
      amplitude: opts.amplitude,
      frequency: opts.frequency,
      world: baked && { name: baked.name, minChunk: baked.minChunk, maxChunk: baked.maxChunk },
      area,
      totalTiles: world.total,
      // Stored tiles exist outside this area: the editor pins the border
      // samples it shares with them (see HeightGrid.pinBorders).
      partial: world.stored && world.tiles.length < world.total,
      tiles: world.tiles.map(toWire),
      props: props.map((t) => [t.px, t.py, t.pz]),
    };
  } finally {
    rowStore.close();
    tileStore.close();
    store.close();
  }
}

function cmdGenerate(): unknown {
  const req = JSON.parse(readStdin()) as {
    amplitude?: number;
    frequency?: number;
    chunks?: Array<[number, number]>;
  };
  const opts = { ...terrainOptionsFromEnv() };
  if (req.amplitude !== undefined) {
    if (!Number.isFinite(req.amplitude) || req.amplitude <= 0) throw new Error("amplitude must be a positive number");
    opts.amplitude = req.amplitude;
  }
  if (req.frequency !== undefined) {
    if (!Number.isFinite(req.frequency) || req.frequency <= 0 || req.frequency > 1) {
      throw new Error("frequency must be in (0, 1]");
    }
    opts.frequency = req.frequency;
  }
  const coords = req.chunks && req.chunks.length > 0 ? req.chunks : defaultArea();
  return { tiles: generatedTiles(coords, opts).map(toWire) };
}

function cmdImport(): unknown {
  const pid = runningServerPid(DATA_DIR);
  if (pid !== null) {
    throw new Error(
      `the game server (pid ${pid}) is running on this world — stop it, then save again ` +
        `(its next save would overwrite the edit)`,
    );
  }
  const req = JSON.parse(readStdin()) as { tiles?: WireTile[] };
  if (!Array.isArray(req.tiles) || req.tiles.length === 0) throw new Error("no tiles to save");
  const incoming = req.tiles.map(fromWire);

  // Only the edited tiles and their neighbours are read, never the whole
  // world; one editor area (plus its neighbour ring) bounds that.
  const range: ChunkRange = [Infinity, Infinity, -Infinity, -Infinity];
  for (const t of incoming) {
    range[0] = Math.min(range[0], t.cx - 1);
    range[1] = Math.min(range[1], t.cz - 1);
    range[2] = Math.max(range[2], t.cx + 1);
    range[3] = Math.max(range[3], t.cz + 1);
  }
  const span = 2 * MAX_AREA_RADIUS + 3;
  if (range[2] - range[0] + 1 > span || range[3] - range[1] + 1 > span) {
    throw new Error(
      `edited tiles span more than one editor area (${2 * MAX_AREA_RADIUS + 1} chunks); save areas separately`,
    );
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const store = new SnapshotStore({ dbPath: DB_PATH });
  try {
    const baked = bakedWorld(store);
    if (baked) {
      for (const t of incoming) {
        if (t.cx < baked.minChunk || t.cx > baked.maxChunk || t.cz < baked.minChunk || t.cz > baked.maxChunk) {
          throw new Error(`tile ${t.cx},${t.cz} is outside the world (chunks ${baked.minChunk}..${baked.maxChunk})`);
        }
      }
    }
    const peek = new TerrainTileStore(DB_PATH);
    const world = openWorld(store, peek, range);
    peek.close();
    const rowPeek = new ChunkEntityStore(DB_PATH);
    const rows = unloadedRows(rowPeek, world.state, range);
    rowPeek.close();

    // The saved area = current tiles with the edited ones swapped in. A
    // grid over them rejects any seam between an edited tile and an
    // untouched neighbour (and malformed tiles).
    const before = new Map(world.tiles.map((t) => [chunkKey(t.cx, t.cz), t]));
    const after = new Map(before);
    for (const t of incoming) after.set(chunkKey(t.cx, t.cz), t);
    HeightGrid.fromTiles([...after.values()]);

    const changed = incoming.filter((t) => {
      const old = before.get(chunkKey(t.cx, t.cz));
      return !old || old.heights.some((v, i) => v !== t.heights[i]);
    });
    // First save of a world without stored tiles stores ALL of them, so
    // the terrain becomes data everywhere, not just where it was edited.
    const toWrite = world.stored ? changed : [...after.values()];

    // Keep props planted, in loaded chunks (the snapshot) and unloaded ones
    // (their rows).
    let reseated = 0;
    let snapshotBytes: Uint8Array | null = null;
    const rowWrites: Array<{ cx: number; cz: number; tick: number; bytes: Uint8Array }> = [];
    if (changed.length > 0) {
      const edited = new Map(changed.map((t) => [chunkKey(t.cx, t.cz), t]));
      if (world.snapshot && world.state) {
        const moved = reseat(propRows(world.state), edited, before);
        if (moved > 0) snapshotBytes = encodeSnapshot(world.state);
        reseated += moved;
      }
      for (const row of rows) {
        const moved = reseat(row.state.transforms, edited, before);
        if (moved > 0) rowWrites.push({ cx: row.cx, cz: row.cz, tick: row.tick, bytes: encodeSnapshot(row.state).slice() });
        reseated += moved;
      }
    }

    store.transaction((db) => {
      const tiles = new TerrainTileStore(db);
      tiles.putMany(toWrite);
      new ChunkEntityStore(db).putMany(rowWrites);
      if (snapshotBytes && world.snapshot) {
        const gens = world.snapshot.generations;
        const table = new Uint32Array(gens.size === 0 ? 0 : Math.max(...gens.keys()) + 1);
        for (const [slot, gen] of gens) table[slot] = gen;
        store.saveSnapshotBytes(world.snapshot.tick, snapshotBytes, table, world.snapshot.entityCount);
      }
    });
    return {
      saved: toWrite.length,
      changed: changed.map((t) => [t.cx, t.cz]),
      reseatedProps: reseated,
    };
  } finally {
    store.close();
  }
}

function main(): void {
  const cmd = process.argv[2];
  const run = { export: cmdExport, generate: cmdGenerate, import: cmdImport }[cmd ?? ""];
  if (!run) {
    process.stderr.write("usage: terrain-tool.js export [< area.json] | generate < req.json | import < tiles.json\n");
    process.exit(2);
  }
  try {
    process.stdout.write(JSON.stringify(run()));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

main();
