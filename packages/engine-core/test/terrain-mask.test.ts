/**
 * Terrain masks: seeded, reproducible, one channel per parameter, and the
 * spec is validated. Golden hashes pin the bytes for a fixed fixture.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TERRAIN_MASK_SPEC, type TerrainMaskSpec } from "@mmo-engine/art/browser";
import { bakeTerrainMask, maskHash, type TerrainMaskInputs } from "../src/terrain/terrain-mask.js";

const N = 32;

/** A fixed fixture: a slope ramp, a moisture ramp, a flow field and a road across the middle. */
function fixture(): TerrainMaskInputs {
  const slope = new Float32Array(N * N);
  const moisture = new Float32Array(N * N);
  const flow = new Float32Array(N * N);
  const road = new Uint8Array(N * N);
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = z * N + x;
      slope[i] = (x / (N - 1)) * 60;
      moisture[i] = z / (N - 1);
      flow[i] = ((x * 7 + z * 3) % 11) / 10;
      road[i] = z === N >> 1 ? 1 : 0;
    }
  }
  return { slope, moisture, flow, road };
}

const CHUNK = { originX: 512, originZ: -256, cellMetres: 1 };
const spec = (over: Partial<TerrainMaskSpec> = {}): TerrainMaskSpec => ({ ...DEFAULT_TERRAIN_MASK_SPEC, resolution: N, ...over });

/** The channel `c` of an RGBA buffer, one byte per sample. */
const channel = (bytes: Uint8Array, c: number): number[] => {
  const out: number[] = [];
  for (let i = c; i < bytes.length; i += 4) out.push(bytes[i]);
  return out;
};

describe("terrain mask bake", () => {
  it("is deterministic: same spec, chunk and inputs give the same bytes", () => {
    const a = bakeTerrainMask(spec(), CHUNK, fixture());
    const b = bakeTerrainMask(spec(), CHUNK, fixture());
    assert.equal(maskHash(a), maskHash(b));
    assert.equal(a.length, N * N * 4);
  });

  it("golden hash for the fixed fixture (pins the bake)", () => {
    const bytes = bakeTerrainMask(spec(), CHUNK, fixture());
    assert.equal(maskHash(bytes), GOLDEN);
  });

  it("a different seed changes the base channel's noise", () => {
    const a = bakeTerrainMask(spec({ seed: 1 }), CHUNK, fixture());
    const b = bakeTerrainMask(spec({ seed: 2 }), CHUNK, fixture());
    assert.notDeepEqual(channel(a, 0), channel(b, 0));
  });

  it("changing the rock slope thresholds changes only the rock channel", () => {
    const base = spec();
    const moved = spec({ rock: { ...base.rock, slope: { ...base.rock.slope, from: 10, to: 30 } } });
    const a = bakeTerrainMask(base, CHUNK, fixture());
    const b = bakeTerrainMask(moved, CHUNK, fixture());
    assert.notDeepEqual(channel(a, 1), channel(b, 1), "rock changed");
    for (const c of [0, 2, 3]) assert.deepEqual(channel(a, c), channel(b, c), `channel ${c} unchanged`);
  });

  it("changing the wet thresholds changes only the wet channel", () => {
    const base = spec();
    const moved = spec({ wet: { ...base.wet, moisture: { ...base.wet.moisture, from: 0.2, to: 0.4 } } });
    const a = bakeTerrainMask(base, CHUNK, fixture());
    const b = bakeTerrainMask(moved, CHUNK, fixture());
    assert.notDeepEqual(channel(a, 2), channel(b, 2), "wet changed");
    for (const c of [0, 1, 3]) assert.deepEqual(channel(a, c), channel(b, c), `channel ${c} unchanged`);
  });

  it("changing the path feather changes only the path channel", () => {
    const a = bakeTerrainMask(spec({ path: { featherCells: 0 } }), CHUNK, fixture());
    const b = bakeTerrainMask(spec({ path: { featherCells: 3 } }), CHUNK, fixture());
    assert.notDeepEqual(channel(a, 3), channel(b, 3), "path changed");
    for (const c of [0, 1, 2]) assert.deepEqual(channel(a, c), channel(b, c), `channel ${c} unchanged`);
  });

  it("path is full on the road and fades off it", () => {
    const bytes = bakeTerrainMask(spec({ path: { featherCells: 0 } }), CHUNK, fixture());
    const onRoad = (N >> 1) * N + 5;
    assert.equal(bytes[onRoad * 4 + 3], 255);
    assert.equal(bytes[(0 * N + 5) * 4 + 3], 0);
  });

  it("rock is higher on steep ground than flat ground", () => {
    const bytes = bakeTerrainMask(spec({ rock: { ...DEFAULT_TERRAIN_MASK_SPEC.rock, moistureDamping: 0 } }), CHUNK, fixture());
    const flat = bytes[(0 * N + 0) * 4 + 1];
    const steep = bytes[(0 * N + (N - 1)) * 4 + 1];
    assert.ok(steep > flat, `steep ${steep} > flat ${flat}`);
  });

  it("rejects an invalid spec and names the field", () => {
    const bad = { ...spec(), path: { featherCells: 99 } } as unknown as TerrainMaskSpec;
    assert.throws(() => bakeTerrainMask(bad, CHUNK, fixture()), /featherCells|path/);
  });

  it("rejects inputs of the wrong size", () => {
    const f = fixture();
    f.slope = new Float32Array(10);
    assert.throws(() => bakeTerrainMask(spec(), CHUNK, f), /slope/);
  });
});

// FNV-1a of the fixture's bake. Repinned when the base channel took a biome input
// (half the base is now the biome's ground type; rock, wet and path bytes did not change).
const GOLDEN = "09445747";
