/**
 * D4g: every decal kind the dungeon generator places has a props.json entry that
 * spawns (asset is its own id, so the run registers its mesh) and a mesh (a
 * placeholder until its art exists), and none of them blocks movement. A kind
 * with no entry is silently not spawned, so this keeps the decals on screen.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { propMesh } from "../src/dungeons/prop-mesh.js";

// The decal kinds dungeon/src/generate.ts pushes as surface dressing (cracks, moss, roots, bones, icicles).
const DECAL_KINDS = ["crack", "moss", "roots", "bones", "icicle"] as const;

const props = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../content/dungeons/props.json", import.meta.url)), "utf8")) as {
  archetypes: Record<string, { asset: string; collision?: { shape?: string } }>;
};

describe("dungeon decals (D4g)", () => {
  for (const kind of DECAL_KINDS) {
    it(`${kind}: spawns from props.json, has a mesh, and does not block`, () => {
      const id = `dungeon:${kind}`;
      const a = props.archetypes[id];
      assert.ok(a, `${id} has a props.json entry`);
      assert.equal(a.asset, id, "its asset is its own id, so the run registers its mesh");
      assert.equal(a.collision?.shape, "none", "a decal does not block movement");
      const mesh = propMesh(kind);
      assert.ok(mesh && mesh.byteLength > 0, `${kind} has a placeholder mesh`);
    });
  }
});
