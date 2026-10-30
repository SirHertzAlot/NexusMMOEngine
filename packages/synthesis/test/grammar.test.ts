import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  INTERIOR_GRAMMAR_FORMAT,
  InteriorCatalogSchema,
  InteriorGrammarSchema,
  MAX_PLAN_CELLS,
  InteriorStyleSchema,
  placeInterior,
  yawDegrees,
  type InteriorGrammar,
  type InteriorStyle,
  type LearnedRuleSet,
  type PartDef,
  type SynthesizedPlacement,
} from "../src/index.js";

const contentDir = join(process.cwd(), "..", "..", "content", "synthesis");
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

function part(id: string, category: string, size: [number, number, number]): PartDef {
  const half = size.map((v) => v / 2);
  return {
    id,
    assetRef: `${id}.glb`,
    category,
    bounds: { min: [-half[0], 0, -half[2]], max: [half[0], size[1], half[2]], size },
    sockets: [],
  };
}

function ruleSetOf(parts: PartDef[]): LearnedRuleSet {
  return {
    family: "test",
    extractorVersion: "test",
    sourceAssemblies: [],
    parts: Object.fromEntries(parts.map((p) => [p.id, p])),
    adjacency: [],
    terminals: [],
    stats: { totalPlacements: 0, uniqueParts: parts.length, totalAdjacencyPairs: 0, categoryDistribution: {}, partFrequencies: {} },
  };
}

const RULES = ruleSetOf([
  part("floor_slab", "floor", [5, 0.2, 5]),
  part("wall_slab", "wall", [5, 4, 0.5]),
  part("door_slab", "door", [2.5, 4, 0.5]),
  part("stone_slab", "stone", [5, 4, 0.5]),
]);

const grammarOf = (plan: string[], doors: InteriorGrammar["doors"] = []): InteriorGrammar =>
  InteriorGrammarSchema.parse({ format: INTERIOR_GRAMMAR_FORMAT, id: "test-room", plan, doors });
const PLAIN: InteriorStyle = InteriorStyleSchema.parse({ id: "plain" });
const count = (placements: SynthesizedPlacement[], category: string): number =>
  placements.filter((p) => p.category === category).length;

describe("interior grammar schema", () => {
  it("fills in 5 m cells and 4 m walls when the grammar leaves them out", () => {
    const g = grammarOf(["..", ".."]);
    assert.equal(g.cellM, 5);
    assert.equal(g.wallHeightM, 4);
    assert.deepEqual(g.doors, []);
  });

  it("rejects a doorway that is not on the outer wall", () => {
    const result = InteriorGrammarSchema.safeParse({
      format: INTERIOR_GRAMMAR_FORMAT,
      id: "test-room",
      plan: ["#.", ".."],
      doors: [{ side: "N", index: 0 }],
    });
    assert.equal(result.success, false);
  });

  it("rejects plan rows of different widths", () => {
    const result = InteriorGrammarSchema.safeParse({ format: INTERIOR_GRAMMAR_FORMAT, id: "test-room", plan: ["..", "..."] });
    assert.equal(result.success, false);
  });
});

describe("placeInterior", () => {
  it("lays a 2x2 open plan as four floors and eight outer walls", () => {
    const placements = placeInterior(grammarOf(["..", ".."]), PLAIN, RULES, 1);
    assert.equal(count(placements, "floor"), 4);
    assert.equal(count(placements, "wall"), 8);
    assert.equal(count(placements, "door"), 0);
  });

  it("puts a doorway in place of one outer wall, centred on its cell", () => {
    const placements = placeInterior(grammarOf(["..", ".."], [{ side: "S", index: 1 }]), PLAIN, RULES, 1);
    assert.equal(count(placements, "wall"), 9, "seven full walls, and two segments either side of the door");
    assert.equal(count(placements, "door"), 1);
    const door = placements.find((p) => p.category === "door")!;
    assert.deepEqual([door.transform.pos[0], door.transform.pos[2]], [2.5, 5]);
    assert.ok(Math.abs(Math.abs(yawDegrees(door.transform.rot)) - 180) < 1e-6, "a south doorway faces out to -z, into the room");
  });

  it("walls a solid cell's edges too, so an L-shaped plan has eight walls", () => {
    const placements = placeInterior(grammarOf(["..", ".#"]), PLAIN, RULES, 1);
    assert.equal(count(placements, "floor"), 3);
    assert.equal(count(placements, "wall"), 8);
  });

  it("turns every wall to face into the room", () => {
    const placements = placeInterior(grammarOf(["...", "...", "...", "...", "...", "..."], [{ side: "S", index: 1 }]), PLAIN, RULES, 7);
    for (const p of placements.filter((q) => q.category === "wall")) {
      const [x, , z] = p.transform.pos;
      const rad = (yawDegrees(p.transform.rot) * Math.PI) / 180;
      const forward = [Math.sin(rad), Math.cos(rad)];
      const towardRoom = [-x, -z];
      assert.ok(forward[0] * towardRoom[0] + forward[1] * towardRoom[1] > 0, `wall at ${x},${z} faces away from the room`);
    }
  });

  it("gives each placed part the size of its cell or wall", () => {
    const placements = placeInterior(grammarOf(["..", ".."]), PLAIN, RULES, 1);
    const wall = placements.find((p) => p.category === "wall")!;
    const floor = placements.find((p) => p.category === "floor")!;
    assert.deepEqual(wall.size, [5, 4, 0.5]);
    assert.deepEqual(floor.size, [5, 0.2, 5]);
  });

  it("lets one grammar wear another style", () => {
    const stone = InteriorStyleSchema.parse({ id: "stone-room", categories: { wall: "stone" } });
    const placements = placeInterior(grammarOf(["..", ".."]), stone, RULES, 1);
    assert.equal(count(placements, "stone"), 8);
    assert.equal(count(placements, "wall"), 0);
    assert.equal(count(placements, "floor"), 4);
  });

  it("names the style and the missing category when the style has no parts for a feature", () => {
    const style = InteriorStyleSchema.parse({ id: "bare", categories: { door: "portcullis" } });
    assert.throws(() => placeInterior(grammarOf(["..", ".."], [{ side: "S", index: 0 }]), style, RULES, 1), /"portcullis" parts for the door/);
  });

  it("places the same parts for the same seed", () => {
    const a = placeInterior(grammarOf(["...", "..."]), PLAIN, RULES, 42);
    const b = placeInterior(grammarOf(["...", "..."]), PLAIN, RULES, 42);
    assert.deepEqual(a, b);
  });
});

describe("doorway gaps", () => {
  it("flanks each door with a wall segment, leaving the opening the doorway's width", () => {
    const placements = placeInterior(grammarOf(["..", ".."], [{ side: "S", index: 1 }]), PLAIN, RULES, 1);
    // The south wall of the doorway's cell sits at x 0 to 5; the other cell's south wall is at x -2.5.
    const segments = placements.filter((p) => p.category === "wall" && p.transform.pos[2] === 5 && p.transform.pos[0] > 0);
    assert.equal(segments.length, 2);
    assert.deepEqual(segments.map((p) => p.transform.pos[0]).sort((a, b) => a - b), [0.625, 4.375]);
    for (const s of segments) assert.deepEqual(s.size, [1.25, 4, 0.5]);
  });

  it("leaves no segment when the doorway is as wide as its cell", () => {
    const wide = InteriorGrammarSchema.parse({
      format: INTERIOR_GRAMMAR_FORMAT,
      id: "test-room",
      plan: ["..", ".."],
      doors: [{ side: "S", index: 1 }],
      doorwayM: 5,
    });
    const placements = placeInterior(wide, PLAIN, RULES, 1);
    assert.equal(count(placements, "wall"), 7);
    assert.equal(count(placements, "door"), 1);
    assert.deepEqual(placements.find((p) => p.category === "door")!.size, [5, 4, 0.5]);
  });

  it("rejects a doorway wider than its cell", () => {
    const result = InteriorGrammarSchema.safeParse({ format: INTERIOR_GRAMMAR_FORMAT, id: "test-room", plan: [".."], doorwayM: 6 });
    assert.equal(result.success, false);
  });
});

describe("interior edge and base cases", () => {
  const base = { format: INTERIOR_GRAMMAR_FORMAT, id: "test-room" };

  it("rejects a plan with no floor cell", () => {
    assert.equal(InteriorGrammarSchema.safeParse({ ...base, plan: ["##", "##"] }).success, false);
  });

  it("rejects a plan longer than the cell limit, in width or in rows", () => {
    assert.equal(InteriorGrammarSchema.safeParse({ ...base, plan: [".".repeat(MAX_PLAN_CELLS + 1)] }).success, false);
    assert.equal(InteriorGrammarSchema.safeParse({ ...base, plan: Array(MAX_PLAN_CELLS + 1).fill(".") }).success, false);
  });

  it("rejects a doorway past the end of its side, and one listed twice", () => {
    assert.equal(InteriorGrammarSchema.safeParse({ ...base, plan: ["..", ".."], doors: [{ side: "S", index: 2 }] }).success, false);
    const twice = [{ side: "S" as const, index: 1 }, { side: "S" as const, index: 1 }];
    assert.equal(InteriorGrammarSchema.safeParse({ ...base, plan: ["..", ".."], doors: twice }).success, false);
  });

  it("places one floor and four walls for a single-cell room", () => {
    const placements = placeInterior(grammarOf(["."]), PLAIN, RULES, 1);
    assert.equal(count(placements, "floor"), 1);
    assert.equal(count(placements, "wall"), 4);
  });

  it("walls both long sides of a one-wide corridor, and a doorway cuts one of them", () => {
    const corridor = placeInterior(grammarOf([".", ".", ".", ".", "."]), PLAIN, RULES, 1);
    assert.equal(count(corridor, "floor"), 5);
    assert.equal(count(corridor, "wall"), 12, "5 west, 5 east, 1 north, 1 south");
    const cut = placeInterior(grammarOf([".", ".", ".", ".", "."], [{ side: "W", index: 2 }]), PLAIN, RULES, 1);
    assert.equal(count(cut, "wall"), 13, "eleven full walls, and two segments either side of the door");
    assert.equal(count(cut, "door"), 1);
  });

  it("walls the cells around a solid pillar, and the pillar's faces", () => {
    const ring = placeInterior(grammarOf(["...", ".#.", "..."]), PLAIN, RULES, 1);
    assert.equal(count(ring, "floor"), 8);
    assert.equal(count(ring, "wall"), 16, "12 on the outside, 4 facing the pillar");
  });

  it("cuts two doorways on one corner cell, each on the side it names", () => {
    const placements = placeInterior(grammarOf(["..", ".."], [{ side: "N", index: 0 }, { side: "W", index: 0 }]), PLAIN, RULES, 1);
    assert.equal(count(placements, "wall"), 10, "six full walls, and four segments beside the two doors");
    assert.equal(count(placements, "door"), 2);
    const doors = placements
      .filter((p) => p.category === "door")
      .map((p) => `${p.transform.pos[0]},${p.transform.pos[2]}`)
      .sort();
    assert.deepEqual(doors, ["-2.5,-5", "-5,-2.5"]);
  });

  it("names every missing category before placing anything", () => {
    const style = InteriorStyleSchema.parse({ id: "hollow", categories: { floor: "moat", wall: "pit" } });
    assert.throws(
      () => placeInterior(grammarOf(["..", ".."]), style, RULES, 1),
      /no "moat" parts for the floor and no "pit" parts for the wall/,
    );
  });

  it("names the feature when the rule set has no parts at all", () => {
    assert.throws(() => placeInterior(grammarOf(["."]), PLAIN, ruleSetOf([]), 1), /no "floor" parts for the floor/);
  });

  it("gives a flat asset the cell's size, and keeps every number finite", () => {
    const flat = ruleSetOf([part("floor_flat", "floor", [0, 0, 0]), part("wall_flat", "wall", [0, 0, 0])]);
    const placements = placeInterior(grammarOf(["..", "#."]), PLAIN, flat, 1);
    for (const p of placements) {
      for (const v of [...p.transform.pos, ...p.transform.rot, ...p.transform.scale, ...p.size]) {
        assert.ok(Number.isFinite(v), `${p.partId} has a non-finite value`);
      }
    }
    const wall = placements.find((p) => p.category === "wall")!;
    assert.deepEqual(wall.size.slice(0, 2), [5, 4]);
  });

  it("places the same room for seed zero and for a negative seed", () => {
    for (const seed of [0, -7]) {
      const placements = placeInterior(grammarOf(["..", ".."]), PLAIN, RULES, seed);
      assert.equal(count(placements, "floor"), 4);
      assert.equal(count(placements, "wall"), 8);
      assert.deepEqual(placeInterior(grammarOf(["..", ".."]), PLAIN, RULES, seed), placements);
    }
  });

  it("walls every floor edge that faces off the plan, with a doorway's wall split in two, for random plans", () => {
    let state = 20261030;
    const next = (n: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % n;
    };
    const STEP: Record<"N" | "S" | "E" | "W", [number, number]> = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] };
    let checked = 0;
    for (let trial = 0; trial < 200; trial++) {
      const cols = 1 + next(8);
      const rows = 1 + next(8);
      const plan: string[] = [];
      for (let r = 0; r < rows; r++) plan.push(Array.from({ length: cols }, () => (next(10) < 6 ? "." : "#")).join(""));
      if (!plan.some((row) => row.includes("."))) continue;
      checked++;
      const isFloor = (c: number, r: number): boolean => plan[r]?.[c] === ".";

      const candidates: InteriorGrammar["doors"] = [];
      for (const side of ["N", "S", "E", "W"] as const) {
        const along = side === "N" || side === "S" ? cols : rows;
        for (let index = 0; index < along; index++) {
          const c = side === "E" ? cols - 1 : side === "W" ? 0 : index;
          const r = side === "S" ? rows - 1 : side === "N" ? 0 : side === "W" || side === "E" ? index : 0;
          const [dc, dr] = STEP[side];
          if (isFloor(c, r) && !isFloor(c + dc, r + dr)) candidates.push({ side, index });
        }
      }
      const doors = candidates.filter(() => next(3) === 0).slice(0, 3);

      let edges = 0;
      let floors = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (!isFloor(c, r)) continue;
          floors++;
          for (const [dc, dr] of Object.values(STEP)) if (!isFloor(c + dc, r + dr)) edges++;
        }
      }

      const placements = placeInterior(grammarOf(plan, doors), PLAIN, RULES, trial + 1);
      assert.equal(count(placements, "floor"), floors, `trial ${trial}: floors`);
      assert.equal(count(placements, "door"), doors.length, `trial ${trial}: doors`);
      assert.equal(count(placements, "wall"), edges + doors.length, `trial ${trial}: walls`);
      for (const p of placements) {
        for (const v of [...p.transform.pos, ...p.transform.rot, ...p.transform.scale, ...p.size]) {
          assert.ok(Number.isFinite(v), `trial ${trial}: non-finite value`);
        }
      }
    }
    assert.ok(checked > 150, `only ${checked} random plans had floor`);
  });
});

describe("openings and open archways", () => {
  it("opens a doorway given by cell and side, on the face it names", () => {
    const placements = placeInterior(grammarOf(["..", ".."], [{ side: "E", c: 1, r: 0 }]), PLAIN, RULES, 1);
    const door = placements.find((p) => p.category === "door")!;
    assert.deepEqual([door.transform.pos[0], door.transform.pos[2]], [5, -2.5]);
    assert.equal(count(placements, "wall"), 9, "seven full walls, and two segments either side of the door");
  });

  it("leaves an open archway bare when the style's door category is empty", () => {
    const arch = InteriorStyleSchema.parse({ id: "arch", categories: { door: "" } });
    const placements = placeInterior(grammarOf(["..", ".."], [{ side: "S", index: 1 }]), arch, RULES, 1);
    assert.equal(count(placements, "door"), 0);
    assert.equal(count(placements, "wall"), 9, "the walls either side of the opening stay");
  });

  it("rejects a cell-and-side doorway that does not open from a floor cell", () => {
    const result = InteriorGrammarSchema.safeParse({
      format: INTERIOR_GRAMMAR_FORMAT,
      id: "test-room",
      plan: ["#.", ".."],
      doors: [{ side: "N", c: 0, r: 0 }],
    });
    assert.equal(result.success, false);
  });

  it("rejects the same face given twice, once by index and once by cell", () => {
    const result = InteriorGrammarSchema.safeParse({
      format: INTERIOR_GRAMMAR_FORMAT,
      id: "test-room",
      plan: ["..", ".."],
      doors: [{ side: "S", index: 1 }, { side: "S", c: 1, r: 1 }],
    });
    assert.equal(result.success, false);
  });
});

describe("interior content", () => {
  it("parses every grammar and style, and each grammar is named after its file", () => {
    for (const file of readdirSync(join(contentDir, "grammars"))) {
      const g = InteriorGrammarSchema.parse(readJson(join(contentDir, "grammars", file)));
      assert.equal(g.id, basename(file, ".json"));
    }
    for (const file of readdirSync(join(contentDir, "styles"))) {
      const s = InteriorStyleSchema.parse(readJson(join(contentDir, "styles", file)));
      assert.equal(s.id, basename(file, ".json"));
    }
  });

  it("points every catalog entry at a grammar and style that exist", () => {
    const catalog = InteriorCatalogSchema.parse(readJson(join(contentDir, "interiors.json")));
    for (const [id, entry] of Object.entries(catalog.interiors)) {
      assert.ok(existsSync(join(contentDir, "grammars", `${entry.grammar}.json`)), `${id}: no grammar "${entry.grammar}"`);
      assert.ok(existsSync(join(contentDir, "styles", `${entry.style}.json`)), `${id}: no style "${entry.style}"`);
    }
  });
});
