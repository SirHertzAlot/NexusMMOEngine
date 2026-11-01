/**
 * Paved streets routed over the ground (SG2b): with a site's router, each paved street carries its centreline
 * and the scene lays it as a chain of slabs; without one, nothing changes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_RULES, generateSettlement, settlementScene, type SettlementRequest } from "../src/index.js";

const origin: [number, number] = [100, 200];
const base: SettlementRequest = { settlementId: "0182", seed: 1234, population: 600 };

/** A router that bends every street through a point 3 m to the side of its midpoint, rising 1 m at the far end. */
const bend = (from: [number, number], to: [number, number]) => {
  const mid = [(from[0] + to[0]) / 2 + 0.003, (from[1] + to[1]) / 2];
  return [
    { x: from[0], z: from[1], h: 0 },
    { x: mid[0]!, z: mid[1]!, h: 0.5 },
    { x: to[0], z: to[1], h: 1 },
  ];
};

const plain = generateSettlement({ ...base, site: { origin, dry: () => true } });
const routed = generateSettlement({ ...base, site: { origin, dry: () => true, route: bend } });
if (!plain.ok || !routed.ok) throw new Error("the town must generate");

describe("routed streets", () => {
  it("no router: no street carries a path, and the town is the same as with no site", () => {
    const none = generateSettlement(base);
    if (!none.ok) throw new Error("base town");
    assert.ok(plain.manifest.roads.edges.every((e) => e.path === undefined));
    assert.equal(JSON.stringify(plain.manifest.roads.edges), JSON.stringify(none.manifest.roads.edges));
  });

  it("a router gives every paved street its centreline, from one junction to the other", () => {
    const paved = routed.manifest.roads.edges.filter((e) => e.surface === "paved");
    assert.ok(paved.length > 0, "the town has paved streets");
    const at = new Map(routed.manifest.roads.nodes.map((n) => [n.id, n]));
    for (const e of paved) {
      assert.ok(e.path && e.path.length === 3, `${e.id} has three points`);
      const a = at.get(e.from)!;
      const b = at.get(e.to)!;
      const first = e.path![0]!;
      const last = e.path![2]!;
      // The path is measured from the town centre; its ends span exactly the junctions' separation.
      assert.equal(last.x - first.x, b.x - a.x, `${e.id} spans its junctions in x`);
      assert.equal(last.z - first.z, b.z - a.z, `${e.id} spans its junctions in z`);
      assert.equal(first.h, 0);
      assert.equal(last.h, 1);
    }
  });

  it("the scene lays each routed street as one slab per leg, and an unrouted one as a single slab", () => {
    const scene = settlementScene(routed.manifest, BUILTIN_RULES, { origin });
    const kids = scene.nodes[0]!.children!.map((n) => n.id);
    for (const e of routed.manifest.roads.edges.filter((x) => x.surface === "paved")) {
      assert.ok(kids.includes(`paving-${e.id}-0`) && kids.includes(`paving-${e.id}-1`), `${e.id} has a slab per leg`);
      assert.ok(!kids.includes(`paving-${e.id}`), `${e.id} is not also one straight slab`);
    }
    const plainScene = settlementScene(plain.manifest, BUILTIN_RULES, { origin });
    const plainKids = plainScene.nodes[0]!.children!.map((n) => n.id);
    for (const e of plain.manifest.roads.edges.filter((x) => x.surface === "paved")) {
      assert.ok(plainKids.includes(`paving-${e.id}`), `${e.id} stays one straight slab`);
    }
  });

  it("a routed slab is turned to its leg and sits on the ground there", () => {
    const scene = settlementScene(routed.manifest, BUILTIN_RULES, { origin });
    const slabs = scene.nodes[0]!.children!.filter((n) => /^paving-.*-\d+$/.test(n.id));
    assert.ok(slabs.length > 0);
    for (const s of slabs) {
      const [, yaw] = s.transform!.rotation!;
      assert.ok(Number.isFinite(yaw!) && Math.abs(yaw!) <= 180, `${s.id} yaw is an angle`);
      const size = s.components!.Structure as { width: number; depth: number };
      assert.ok(size.depth > 0 && size.width > 0, `${s.id} has a size`);
      assert.equal(s.components!.Collider?.shape, "none", `${s.id} is walked on`);
    }
  });
});
