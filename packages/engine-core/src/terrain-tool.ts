/**
 * terrain-tool — offline access to the world heightmap, for the editor.
 *
 *   node dist/src/terrain-tool.js export             world tiles + props -> stdout
 *   node dist/src/terrain-tool.js generate < req     generator preview (not saved)
 *   node dist/src/terrain-tool.js import < tiles     save edited tiles
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
 *  - rejects tiles that open a seam against their neighbours;
 *  - moves every prop standing in an edited chunk by the ground change
 *    under it, so trees stay planted on sculpted terrain;
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
  /** The world's current terrain: stored tiles, or generated if none stored yet. */
  tiles: TerrainTile[];
  stored: boolean;
  snapshot: ReturnType<SnapshotStore["loadLatest"]>;
  state: CollectedState | null;
}

function openWorld(store: SnapshotStore, tileStore: TerrainTileStore): WorldView {
  const snapshot = store.loadLatest();
  const state = snapshot ? decodeSnapshot(snapshot.bytes) : null;
  const stored = tileStore.list();
  if (stored.length > 0) return { tiles: stored, stored: true, snapshot, state };
  // No tiles yet: a world baked before tiles were stored, or no world at
  // all. Show what the server would generate for it.
  const coords = state && state.chunks.length > 0 ? snapshotChunks(state) : defaultArea();
  return { tiles: generatedTiles(coords), stored: false, snapshot, state };
}

function cmdExport(): unknown {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const store = new SnapshotStore({ dbPath: DB_PATH });
  const tileStore = new TerrainTileStore(DB_PATH);
  try {
    const world = openWorld(store, tileStore);
    const opts = makeProcgenChunkSource(terrainOptionsFromEnv());
    return {
      chunkWorldSize: CHUNK_SIZE,
      seed: WORLD_SEED.toString(),
      stored: world.stored,
      amplitude: opts.amplitude,
      frequency: opts.frequency,
      tiles: world.tiles.map(toWire),
      props: world.state ? propRows(world.state).map((t) => [t.px, t.py, t.pz]) : [],
    };
  } finally {
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

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const store = new SnapshotStore({ dbPath: DB_PATH });
  try {
    const peek = new TerrainTileStore(DB_PATH);
    const world = openWorld(store, peek);
    peek.close();

    // The saved world = current tiles with the edited ones swapped in. A
    // grid over all of them rejects any seam between an edited tile and an
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

    // Keep props planted: shift each prop in an edited chunk by the change
    // in ground height under it (preserves any intentional offset).
    let reseated = 0;
    let snapshotBytes: Uint8Array | null = null;
    if (world.snapshot && world.state && changed.length > 0) {
      const edited = new Map(changed.map((t) => [chunkKey(t.cx, t.cz), t]));
      for (const row of propRows(world.state)) {
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
          reseated++;
        }
      }
      if (reseated > 0) snapshotBytes = encodeSnapshot(world.state);
    }

    store.transaction((db) => {
      const tiles = new TerrainTileStore(db);
      tiles.putMany(toWrite);
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
    process.stderr.write("usage: terrain-tool.js export | generate < req.json | import < tiles.json\n");
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
