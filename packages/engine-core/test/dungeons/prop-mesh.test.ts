/**
 * Procedural prop meshes: every kind in content/dungeons/props.json has a small hard-edged mesh from primitives, so a
 * dungeon prop is never just a box when no licensed model names it. Metres, Y up, standing kinds on y = 0.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodePcgMesh } from "@mmo-engine/picg";
import { PROP_KINDS, PROP_SLOTS, propMesh } from "../../src/dungeons/prop-mesh.js";
import { DEFAULT_DUNGEON_CONTENT } from "../../src/dungeons/content.js";

const table = JSON.parse(readFileSync(`${DEFAULT_DUNGEON_CONTENT}/props.json`, "utf8")) as {
  archetypes: Record<string, { collision: { halfExtents: [number, number, number] } }>;
};
const kinds = Object.keys(table.archetypes).map((k) => k.replace(/^dungeon:/, ""));
const MOUNTED = new Set(["torch", "banner"]);

describe("propMesh", () => {
  it("has a recipe for every kind in props.json, and for nothing else", () => {
    assert.deepEqual([...PROP_KINDS].sort(), [...kinds].sort());
  });

  it("answers null for a kind it does not know", () => assert.equal(propMesh("nope"), null));

  it("is deterministic", () => {
    for (const k of kinds) assert.deepEqual(propMesh(k), propMesh(k), k);
  });

  for (const kind of kinds) {
    it(`${kind}: a sound mesh of the right size, standing where it should`, () => {
      const bytes = propMesh(kind);
      assert.ok(bytes, "has a mesh");
      const m = decodePcgMesh(bytes);
      const tris = m.indices.length / 3;
      assert.ok(tris >= 12 && tris <= 4000, `${tris} triangles`);
      assert.ok(m.triangleMaterials && m.triangleMaterials.length === tris, "a slot per triangle");
      for (const name of m.materials) assert.ok((PROP_SLOTS as readonly string[]).includes(name), `slot ${name} is a known slot`);
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < m.positions.length; i += 3) for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], m.positions[i + a]);
        hi[a] = Math.max(hi[a], m.positions[i + a]);
      }
      const footprint = Math.max(hi[0] - lo[0], hi[2] - lo[2]);
      assert.ok(footprint >= 0.05 && footprint <= 4, `footprint ${footprint.toFixed(2)} m`);
      if (!MOUNTED.has(kind)) {
        assert.ok(lo[1] >= -1e-6, `rests on the floor (min y ${lo[1]})`);
        const want = table.archetypes[`dungeon:${kind}`].collision.halfExtents[1];
        assert.ok(hi[1] >= want * 0.75 && hi[1] <= want * 1.25, `${hi[1].toFixed(2)} m tall, the table says ${want}`);
      }
      // Outward winding: a closed outward-facing surface has positive signed volume.
      let volume = 0;
      for (let t = 0; t < tris; t++) {
        const p = (n: number): number[] => [m.positions[m.indices[t * 3 + n] * 3], m.positions[m.indices[t * 3 + n] * 3 + 1], m.positions[m.indices[t * 3 + n] * 3 + 2]];
        const [a, b, c] = [p(0), p(1), p(2)];
        volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      }
      assert.ok(volume > 0, `outward winding (volume ${volume.toFixed(3)})`);
    });
  }
});
