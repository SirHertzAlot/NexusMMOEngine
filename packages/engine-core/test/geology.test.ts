/**
 * Macro geology prototype (terrain/geology): the snapshot is explicit and
 * deterministic, projections round-trip, provinces and uplift are golden-
 * pinned, overrides stay local, the survey uses it in place of the ranges,
 * and the bake persists it so a reload never regenerates from a seed:
 * stored maps re-derive to the same hash, and tiles re-bake byte-identical
 * from the stored snapshot. The baked terrain then goes through the engine's
 * own navmesh baker and Jolt height-field colliders.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addComponent } from "bitecs";
import { bakeWorldTerrain } from "../src/terrain/world-bake.js";
import { TerrainTileStore } from "../src/persist/terrain-tiles.js";
import { parseWorldSpec, worldBounds, type WorldSpec } from "../src/terrain/world-spec.js";
import { coarseGrid, fieldSeed, noiseField, surveyWorld } from "../src/terrain/survey.js";
import {
  generateGeologySpec,
  latLonToWorld,
  parseGeologySpec,
  PROVINCE_KINDS,
  unitVectorToWorld,
  worldToLatLon,
  type GeologySpec,
} from "../src/terrain/geology/snapshot.js";
import { classifyGeology, type GeoGrid } from "../src/terrain/geology/provinces.js";
import { findOpportunities } from "../src/terrain/geology/opportunities.js";
import type { GeologyRecord } from "../src/terrain/geology/record.js";
import { TILE_CACHE_SETTINGS } from "../src/navigation/chunk-baker.js";
import { ChunkNavmesh } from "../src/navigation/chunk-navmesh.js";
import { NavmeshTileRegistry } from "../src/index.js";
import { createNavigationBackend, NAV_PATH_STATUS } from "../src/navigation/backend.js";
import type { ChunkDataSource } from "../src/procgen/chunk-source.js";
import { BodyConfig, createJoltBackend, MotionType, PhysicsSystem, ShapeKind, SimWorld, STEP_MS, terrainHeightAt, Transform, Velocity } from "../src/index.js";

const sha = (b: ArrayBufferView): string => createHash("sha256").update(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)).digest("hex").slice(0, 16);

/** A 512 m world: big enough for a few provinces at scaled-down widths. */
const RAW = {
  name: "geology-test",
  seed: 42,
  sizeChunks: 32,
  chunkWorldSize: 16,
  coarseCell: 8,
  regionsPerSide: 1,
  land: {
    seaLevel: 0,
    coast: { shape: "island", islandRadius: 1.0, side: "south", waterEdge: 0.5, tip: 0.85, taper: 0.7, wander: 30, wanderScale: 200 },
    shelfDepth: 20, shelfWidth: 60, rise: 10, riseDistance: 200, relief: 4, reliefScale: 300, minIslandArea: 5000,
  },
  ranges: { count: 1, height: 100, width: 120, length: 300, spurs: 0, spurLength: 100, spurScale: 0.75, ridgeScale: 80, ridges: 0.45, coastClearance: 40 },
  volcano: { count: 0 },
  climate: { wind: "south-west", seaTempC: 20, inlandCoolingC: 5, rainMm: 900, dryDistance: 1500 },
  erosion: { droplets: 3000, strength: 0.3, thermalPasses: 4, fluvialPasses: 2 },
  rivers: { minCatchment: 20000, maxDepth: 2 },
  biomes: [
    { id: "plains", when: { water: "land", height: { min: 0, max: 60 } }, surface: { shape: "rolling", relief: 2, scale: 50 }, roughness: 0.3 },
    { id: "catch-all", surface: { shape: "rolling", relief: 3, scale: 80 }, roughness: 0.5 },
  ],
  minBiomeArea: 500,
};

function testGeology(): GeologySpec {
  const b = worldBounds(parseWorldSpec(RAW));
  const g = generateGeologySpec({ seed: 5, min: b.min, max: b.max, plates: 5, cratons: 1, sutures: 1, geoKmPerWorldKm: 200 });
  return parseGeologySpec({
    ...g,
    widths: { ...g.widths, orogenM: 110, arcM: 70, forelandM: 90, riftM: 60, sutureM: 40, transformM: 30, cratonRimM: 40, warpM: 35, warpScaleM: 220 },
    relief: { ...g.relief, orogenM: 90, arcM: 50, riftM: -12, riftShoulderM: 10, cratonM: 12, sutureM: 18, strikeScaleM: 160, ridgeScaleM: 70, smoothM: 8 },
    minProvinceArea: 2000,
  });
}

const GEO_SPEC: WorldSpec = parseWorldSpec({ ...RAW, geology: testGeology() });
const BASE_SPEC: WorldSpec = parseWorldSpec(RAW);

describe("geology snapshot", () => {
  it("is generated deterministically and survives a JSON round trip", () => {
    const a = testGeology();
    const b = testGeology();
    assert.deepEqual(a, b);
    assert.deepEqual(parseGeologySpec(JSON.parse(JSON.stringify(a))), a);
    assert.equal(a.generator.name, "nexus-geology");
    assert.ok(a.plates.length === 5 && a.cratons.length === 1 && a.sutures.length === 1);
  });

  it("maps world metres to the sphere and back (azimuthal equidistant)", () => {
    const f = testGeology().frame;
    for (const [x, z] of [[0, 0], [250, -250], [-256, 256], [123.4, 77.7]]) {
      const ll = worldToLatLon(f, x, z);
      const back = latLonToWorld(f, ll.latDeg, ll.lonDeg);
      assert.ok(Math.abs(back.x - x) < 1e-6 && Math.abs(back.z - z) < 1e-6, `(${x}, ${z}) -> (${back.x}, ${back.z})`);
    }
    // North is -z and the scale holds: 100 world m north at 200 geo-km per world km = 20 km = ~0.18°.
    const n = worldToLatLon(f, 0, -100);
    assert.ok(n.latDeg > f.originLatDeg);
    assert.ok(Math.abs((n.latDeg - f.originLatDeg) * (Math.PI / 180) * f.planetRadiusKm - 20) < 1e-6);
    // A unit-sphere vector (the globe representation) lands where its lat/lon does.
    const lat = (f.originLatDeg + 0.1) * (Math.PI / 180);
    const lon = (f.originLonDeg - 0.05) * (Math.PI / 180);
    const v = { x: Math.cos(lat) * Math.cos(lon), y: Math.cos(lat) * Math.sin(lon), z: Math.sin(lat) };
    const w = unitVectorToWorld(f, v);
    const w2 = latLonToWorld(f, f.originLatDeg + 0.1, f.originLonDeg - 0.05);
    assert.ok(Math.abs(w.x - w2.x) < 1e-3 && Math.abs(w.z - w2.z) < 1e-3);
  });
});

describe("geology provinces", () => {
  const grid: GeoGrid = coarseGrid(GEO_SPEC);
  const geo = GEO_SPEC.geology!;
  const zeros: (salt: number, scale: number) => Float32Array = () => new Float32Array(grid.width * grid.depth);
  const real = (salt: number, scale: number): Float32Array => noiseField(grid, fieldSeed(geo.seed, 900 + salt), scale);

  it("classify the same snapshot to the same bytes (golden, no noise)", () => {
    const a = classifyGeology(geo, grid, zeros);
    const b = classifyGeology(geo, grid, zeros);
    assert.equal(a.hash, b.hash);
    assert.equal(a.hash, "1f9121d7cf4c41a0");
  });

  it("classify with the strict-IEEE warp noise to a pinned hash (cross-CPU golden)", () => {
    const a = classifyGeology(geo, grid, real);
    assert.equal(a.hash, "4b0e6d9b44bc7554");
  });

  it("finds several distinct provinces, each kind a valid code", () => {
    const f = classifyGeology(geo, grid, real);
    const kinds = new Set(f.provinces.map((p) => p.kind));
    assert.ok(f.provinces.length >= 4, `${f.provinces.length} provinces`);
    assert.ok(kinds.size >= 3, `kinds: ${[...kinds].join(", ")}`);
    for (const k of f.kind) assert.ok(k < PROVINCE_KINDS.length);
    assert.deepEqual(f.provinces.map((p) => p.id), f.provinces.map((_, i) => `G${String(i + 1).padStart(2, "0")}`));
  });

  it("a designer override retags one province and leaves the others alone", () => {
    const f = classifyGeology(geo, grid, real);
    const target = [...f.provinces].sort((p, q) => q.cells - p.cells).find((p) => p.kind !== "ocean")!;
    const newKind = target.kind === "rift" ? "craton" : "rift";
    const edited = parseGeologySpec({ ...geo, overrides: [{ at: { x: target.x, z: target.z }, kind: newKind }] });
    const g = classifyGeology(edited, grid, real);
    const idx = f.provinces.indexOf(target);
    const centre = Math.round((target.z - grid.originZ) / grid.cell) * grid.width + Math.round((target.x - grid.originX) / grid.cell);
    // The override point must lie in the target patch for this test to mean anything.
    if (f.province[centre] !== idx) return;
    let outsideChanged = 0;
    for (let i = 0; i < f.kind.length; i++) {
      if (f.province[i] === idx) assert.equal(PROVINCE_KINDS[g.kind[i]], newKind);
      else if (f.kind[i] !== g.kind[i]) outsideChanged++;
    }
    assert.equal(outsideChanged, 0);
  });
});

describe("geology through the survey and the bake", () => {
  let dir: string;
  let dbPath: string;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-geology-test-"));
    dbPath = path.join(dir, "region.db");
    await bakeWorldTerrain(GEO_SPEC, { dbPath, catalogDir: null, log: () => {}, terrainVersion: 1, workers: 1, masks: false });
  });

  it("the survey takes its uplift from the provinces, deterministically", () => {
    const a = surveyWorld(GEO_SPEC);
    const b = surveyWorld(GEO_SPEC);
    const base = surveyWorld(BASE_SPEC);
    assert.ok(a.geology);
    assert.equal(a.ranges.length, 0, "no wind-placed ranges when geology is on");
    assert.equal(sha(a.height), sha(b.height));
    assert.notEqual(sha(a.height), sha(base.height));
    assert.equal(base.geology, undefined);
  });

  it("persists the snapshot, province table, maps and hash in region.db", () => {
    const store = new TerrainTileStore(dbPath);
    try {
      const rec = store.getDoc<GeologyRecord>("geology_snapshot");
      assert.ok(rec);
      assert.equal(rec.recordVersion, 1);
      assert.deepEqual(rec.snapshot, GEO_SPEC.geology);
      assert.equal(rec.snapshot.frame.projection, "azimuthal-equidistant");
      assert.equal(rec.snapshot.generator.version, "0.1.0");
      for (const name of Object.values(rec.maps)) assert.ok(store.getMap(name), `map ${name}`);
      assert.ok(rec.provinces.length >= 4);
    } finally {
      store.close();
    }
  });

  it("reload: the stored snapshot (not the seed) re-derives the stored maps exactly", () => {
    const store = new TerrainTileStore(dbPath);
    try {
      const rec = store.getDoc<GeologyRecord>("geology_snapshot")!;
      const snapshot = parseGeologySpec(rec.snapshot);
      const grid = coarseGrid(GEO_SPEC);
      const f = classifyGeology(snapshot, grid, (salt, scale) => noiseField(grid, fieldSeed(snapshot.seed, 900 + salt), scale));
      assert.equal(f.hash, rec.fieldsHash);
      assert.equal(sha(store.getMap("geology_province")!.data), sha(f.province));
      assert.equal(sha(store.getMap("geology_uplift")!.data), sha(f.uplift));
      assert.deepEqual(f.provinces, rec.provinces);
    } finally {
      store.close();
    }
  });

  it("reload: re-baking from the stored snapshot gives byte-identical tiles", async () => {
    const store = new TerrainTileStore(dbPath);
    const rec = store.getDoc<GeologyRecord>("geology_snapshot")!;
    const first = store.list();
    store.close();
    const again = path.join(dir, "again.db");
    await bakeWorldTerrain(parseWorldSpec({ ...RAW, geology: rec.snapshot }), { dbPath: again, catalogDir: null, log: () => {}, terrainVersion: 1, workers: 1, masks: false });
    const store2 = new TerrainTileStore(again);
    try {
      const second = store2.list();
      assert.equal(second.length, first.length);
      for (let k = 0; k < first.length; k++) assert.equal(sha(second[k].heights), sha(first[k].heights));
    } finally {
      store2.close();
    }
  });

  it("baked tiles agree on every shared chunk edge (no seams)", () => {
    const store = new TerrainTileStore(dbPath);
    try {
      const tiles = new Map(store.list().map((t) => [`${t.cx},${t.cz}`, t.heights]));
      let edges = 0;
      for (const [key, h] of tiles) {
        const [cx, cz] = key.split(",").map(Number);
        const east = tiles.get(`${cx + 1},${cz}`);
        const south = tiles.get(`${cx},${cz + 1}`);
        for (let k = 0; k < 16; k++) {
          if (east) { assert.equal(h[k * 16 + 15], east[k * 16]); edges++; }
          if (south) { assert.equal(h[15 * 16 + k], south[k]); edges++; }
        }
      }
      assert.ok(edges > 1000);
    } finally {
      store.close();
    }
  });

  it("the opportunity pass is deterministic and keeps its safeguards", () => {
    const s = surveyWorld(GEO_SPEC);
    const a = findOpportunities(s, { deposits: 6, depositSpacingM: 40, minSiteSeparationM: 120, maxBridgeSpanM: 24 });
    const b = findOpportunities(s, { deposits: 6, depositSpacingM: 40, minSiteSeparationM: 120, maxBridgeSpanM: 24 });
    const strip = (r: typeof a): unknown => ({ ...r, timingsMs: null });
    assert.deepEqual(strip(a), strip(b));
    assert.ok(a.deposits.some((d) => d.resource === "ore") && a.deposits.some((d) => d.resource === "fuel"));
    for (const d of a.deposits) assert.ok(d.province && d.kind, "deposits carry their province");
    if (a.sites) assert.ok(a.metrics.routeWithoutBridge, "a pair is only chosen when a route exists without the bridge");
  });

  it("the baked terrain bakes navmesh tiles and paths across chunk seams", () => {
    const store = new TerrainTileStore(dbPath);
    const tiles = new Map(store.list().map((t) => [`${t.cx},${t.cz}`, t.heights]));
    store.close();
    const source: ChunkDataSource = {
      chunkSamples: 256,
      generateChunk: (_seed, cx, cz, _lod, out) => out.set(tiles.get(`${cx},${cz}`) ?? new Float32Array(256)),
    };
    // The flattest dry 3×3 chunk block near the middle of the land.
    const { minChunk, maxChunk } = worldBounds(GEO_SPEC);
    let best: { cx: number; cz: number; spread: number } | null = null;
    for (let cz = minChunk; cz <= maxChunk - 2; cz++) {
      for (let cx = minChunk; cx <= maxChunk - 2; cx++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) for (const h of tiles.get(`${cx + dx},${cz + dz}`) ?? []) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
        if (lo > GEO_SPEC.land.seaLevel + 1 && (!best || hi - lo < best.spread)) best = { cx, cz, spread: hi - lo };
      }
    }
    assert.ok(best, "a dry 3×3 block exists");
    // The server's own path: ChunkNavmesh over the tile cache, fed the stored tiles.
    const backend = createNavigationBackend({
      originX: 0, originZ: 0, tileWorldSize: 16, maxTiles: 64, maxPolys: 1024,
      profiles: [{ id: 0, agentHeight: 2, agentRadius: 0.6, agentMaxClimb: 0.9 }],
      tileCache: TILE_CACHE_SETTINGS,
    });
    const registry = new NavmeshTileRegistry({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "mmo-geology-nav-")) });
    const navmesh = new ChunkNavmesh({ backend, registry, source, seed: 1n, chunkWorldSize: 16 });
    try {
      let loaded = 0;
      for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) if (navmesh.load(best!.cx + dx, best!.cz + dz) === "baked") loaded++;
      assert.ok(loaded >= 6, `${loaded} of 9 tiles baked`);
      const x0 = best!.cx * 16 + 4;
      const z0 = best!.cz * 16 + 4;
      const x1 = (best!.cx + 2) * 16 + 12;
      const z1 = (best!.cz + 2) * 16 + 12;
      const ys = (x: number, z: number): number => {
        const t = tiles.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)!;
        return terrainHeightAt(t, x - Math.floor(x / 16) * 16, z - Math.floor(z / 16) * 16, 16);
      };
      const out = { status: new Int32Array(1), waypointCount: new Uint32Array(1), polyCount: new Uint32Array(1), waypoints: new Float32Array(3 * 64) };
      backend.findPaths({ count: 1, entityIds: new BigUint64Array([1n]), start: new Float32Array([x0, ys(x0, z0) + 0.5, z0]), end: new Float32Array([x1, ys(x1, z1) + 0.5, z1]), profile: new Uint8Array([0]), maxWaypoints: 64 }, out);
      assert.equal(out.status[0], NAV_PATH_STATUS.Ok, "a path crosses the 3×3 block");
      assert.ok(out.polyCount[0] >= 2);
    } finally {
      backend.destroy();
    }
  });

  it("the baked terrain becomes Jolt height-field colliders that hold a body on the surface", (t) => {
    const require = createRequire(import.meta.url);
    try {
      const addon = require("@mmo-engine/addon-physics") as { createWorld(): { addTerrain?: unknown; destroy(): void } };
      const w = addon.createWorld();
      const ok = typeof w.addTerrain === "function";
      w.destroy();
      if (!ok) return t.skip("physics addon has no terrain");
    } catch {
      return t.skip("physics addon not built");
    }
    const store = new TerrainTileStore(dbPath);
    const tiles = store.list();
    store.close();
    const spread = (h: Float32Array): number => Math.max(...h) - Math.min(...h);
    const tile = tiles.filter((tl) => Math.min(...tl.heights) > GEO_SPEC.land.seaLevel + 1).sort((a, b) => spread(a.heights) - spread(b.heights))[0];
    const sim = new SimWorld();
    const physics = new PhysicsSystem(createJoltBackend());
    try {
      physics.terrainColliders(16).add(tile.cx, tile.cz, tile.heights);
      const e = sim.spawn();
      addComponent(sim.ecs, Transform, e);
      addComponent(sim.ecs, Velocity, e);
      addComponent(sim.ecs, BodyConfig, e);
      const [lx, lz] = [8.3, 7.7];
      const ground = terrainHeightAt(tile.heights, lx, lz, 16);
      Transform.px[e] = tile.cx * 16 + lx;
      Transform.py[e] = ground + 1;
      Transform.pz[e] = tile.cz * 16 + lz;
      Transform.qw[e] = 1;
      BodyConfig.shapeKind[e] = ShapeKind.Box;
      BodyConfig.halfX[e] = 0.2;
      BodyConfig.halfY[e] = 0.2;
      BodyConfig.halfZ[e] = 0.2;
      BodyConfig.mass[e] = 1;
      BodyConfig.motionType[e] = MotionType.Dynamic;
      BodyConfig.layer[e] = 1;
      BodyConfig.friction[e] = 1;
      for (let i = 0; i < 60; i++) physics.step(sim, STEP_MS / 1000);
      const under = terrainHeightAt(tile.heights, Transform.px[e] - tile.cx * 16, Transform.pz[e] - tile.cz * 16, 16);
      assert.ok(Math.abs(Transform.py[e] - 0.2 - under) < 0.25, `box at ${Transform.py[e].toFixed(3)} over ground ${under.toFixed(3)}`);
    } finally {
      physics.close();
    }
  });
});
