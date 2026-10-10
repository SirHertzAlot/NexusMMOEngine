/**
 * TDD: MMO_SPAWN_OVERRIDE parsing for the world server.
 *
 * The editor's play mode passes the "Start from" spawn target as
 * MMO_SPAWN_OVERRIDE="x,z". It takes precedence over the world's stored
 * spawn_point. Malformed values are ignored (default spawn wins).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clampSpawn, parseSpawnOverride } from "../src/spawn-override.js";

describe("parseSpawnOverride", () => {
  it("parses 'x,z'", () => {
    assert.deepEqual(parseSpawnOverride("10,20"), { x: 10, z: 20 });
  });

  it("parses negatives and decimals", () => {
    assert.deepEqual(parseSpawnOverride("-12.5,3.25"), { x: -12.5, z: 3.25 });
  });

  it("undefined → null", () => {
    assert.equal(parseSpawnOverride(undefined), null);
  });

  it("empty → null", () => {
    assert.equal(parseSpawnOverride(""), null);
  });

  it("non-numeric → null", () => {
    assert.equal(parseSpawnOverride("abc,def"), null);
    assert.equal(parseSpawnOverride("10"), null);
    assert.equal(parseSpawnOverride("10,20,30"), null);
  });

  it("an empty half → null (not 0)", () => {
    assert.equal(parseSpawnOverride(" ,5"), null);
    assert.equal(parseSpawnOverride("5,"), null);
    assert.equal(parseSpawnOverride(","), null);
  });

  it("whitespace is tolerated", () => {
    assert.deepEqual(parseSpawnOverride(" 10 , 20 "), { x: 10, z: 20 });
  });
});

describe("clampSpawn", () => {
  it("keeps a point inside the chunk range as is", () => {
    assert.deepEqual(clampSpawn({ x: 10, z: -20 }, -2, 1, 32), { x: 10, z: -20 });
  });

  it("pulls a point past the edge back inside the last chunk", () => {
    const p = clampSpawn({ x: 5000, z: -5000 }, -2, 1, 32);
    assert.equal(p.z, -64);
    assert.ok(p.x < 64 && p.x > 63.9, String(p.x));
    assert.equal(Math.floor(p.x / 32), 1);
  });
});
