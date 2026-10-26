import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  expandModuleVariations,
  propagateModuleGrid3D,
  BUILTIN_DUNGEON_MODULES_3D,
  type ModuleVariationDef,
} from "../src/index.js";

describe("3D Grid Module Propagation (WFC)", () => {
  it("expands module variations and accurately rotates sockets across 4 rotations", () => {
    const def: ModuleVariationDef = {
      id: "asymmetric_test",
      moduleType: "wall",
      sockets: { px: "east", nx: "west", py: "north", ny: "south", pz: "up", nz: "down" },
      rotations: 4,
      weight: 1.0,
    };
    const expanded = expandModuleVariations([def]);
    assert.equal(expanded.length, 4);

    // r0
    const r0 = expanded.find((t) => t.rot === 0)!;
    assert.deepEqual(r0.sockets, { px: "east", nx: "west", py: "north", ny: "south", pz: "up", nz: "down" });
    assert.equal(r0.weight, 0.25);

    // r90 (quarter turn clockwise: px' = ny, py' = px, nx' = py, ny' = nx)
    const r90 = expanded.find((t) => t.rot === 90)!;
    assert.deepEqual(r90.sockets, { px: "south", py: "east", nx: "north", ny: "west", pz: "up", nz: "down" });

    // r180 (opposite: px' = nx, py' = ny, nx' = px, ny' = py)
    const r180 = expanded.find((t) => t.rot === 180)!;
    assert.deepEqual(r180.sockets, { px: "west", py: "south", nx: "east", ny: "north", pz: "up", nz: "down" });

    // r270: px' = py, py' = nx, nx' = ny, ny' = px
    const r270 = expanded.find((t) => t.rot === 270)!;
    assert.deepEqual(r270.sockets, { px: "north", py: "west", nx: "south", ny: "east", pz: "up", nz: "down" });
  });

  it("solves a 3D grid ensuring seamless socket continuity across all 6 faces", () => {
    const W = 4, H = 4, D = 3;
    const res = propagateModuleGrid3D({
      width: W,
      height: H,
      depth: D,
      seed: 42,
    });

    assert.equal(res.instances.length, W * H * D);
    assert.equal(res.stats.totalCells, W * H * D);
    assert.ok(res.stats.solveMs >= 0);

    // Verify all internal faces match their adjacent neighbour's opposite face socket
    for (let z = 0; z < D; z++) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const cur = res.get(x, y, z)!;
          assert.ok(cur, `cell (${x},${y},${z}) exists`);

          if (x + 1 < W) {
            const right = res.get(x + 1, y, z)!;
            if (cur.sockets.px !== undefined && right.sockets.nx !== undefined) {
              assert.equal(cur.sockets.px, right.sockets.nx, `X socket mismatch at (${x},${y},${z}) -> (${x+1},${y},${z})`);
            }
          }
          if (y + 1 < H) {
            const forward = res.get(x, y + 1, z)!;
            if (cur.sockets.py !== undefined && forward.sockets.ny !== undefined) {
              assert.equal(cur.sockets.py, forward.sockets.ny, `Y socket mismatch at (${x},${y},${z}) -> (${x},${y+1},${z})`);
            }
          }
          if (z + 1 < D) {
            const above = res.get(x, y, z + 1)!;
            if (cur.sockets.pz !== undefined && above.sockets.nz !== undefined) {
              assert.equal(cur.sockets.pz, above.sockets.nz, `Z socket mismatch at (${x},${y},${z}) -> (${x},${y},${z+1})`);
            }
          }
        }
      }
    }
  });

  it("respects module type layer constraints and propagates fluid variations", () => {
    // 3D Grid: z=0 floor, z=1 wall/pillar, z=2 ceiling
    const W = 3, H = 3, D = 2;
    const cellTypes: string[] = [];
    for (let z = 0; z < D; z++) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (z === 0) {
            cellTypes.push("floor");
          } else {
            // z = 1: make center air/pillar or wall
            cellTypes.push("ceiling");
          }
        }
      }
    }

    const res = propagateModuleGrid3D({
      width: W,
      height: H,
      depth: D,
      cellTypes,
      seed: 99,
    });

    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        const floorCell = res.get(x, y, 0)!;
        assert.equal(floorCell.moduleType, "floor", `cell (${x},${y},0) must be floor`);
        assert.ok(
          floorCell.baseId === "floor_plain" || floorCell.baseId === "floor_cracked" || floorCell.baseId === "floor_drain",
          `unexpected floor variation ${floorCell.baseId}`
        );

        const ceilCell = res.get(x, y, 1)!;
        assert.equal(ceilCell.moduleType, "ceiling", `cell (${x},${y},1) must be ceiling`);
      }
    }
  });

  it("is deterministic per seed and generates varied outputs for different seeds", () => {
    const spec = { width: 4, height: 4, depth: 2, seed: 1234 };
    const resA = propagateModuleGrid3D(spec);
    const resB = propagateModuleGrid3D(spec);

    for (let i = 0; i < resA.instances.length; i++) {
      assert.equal(resA.instances[i].variationId, resB.instances[i].variationId);
      assert.equal(resA.instances[i].rot, resB.instances[i].rot);
    }

    const resC = propagateModuleGrid3D({ ...spec, seed: 5678 });
    const diffCount = resA.instances.filter((inst, idx) => inst.variationId !== resC.instances[idx].variationId).length;
    assert.ok(diffCount > 0, "different seeds should produce distinct variation layouts");
  });

  it("maps Synty model IDs and world coordinates correctly", () => {
    const res = propagateModuleGrid3D({
      width: 2,
      height: 2,
      depth: 1,
      cellSize: 3.5,
      seed: 7,
    });

    const inst = res.get(1, 1, 0)!;
    assert.deepEqual(inst.worldPos, [3.5, 3.5, 0]);
    assert.ok(inst.modelId && inst.modelId.startsWith("dungeon-pack/"));
  });
});
