/**
 * Resource nodes (gathering): the interact key gathers from the nearest
 * node whose edge is in reach, and worked-out nodes are listed to be drawn low.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { MirrorState } from "@mmo-engine/mirror";
import type { ResourceNodeView } from "@mmo-engine/protocol";
import { ResourceNodes } from "../src/render/resource-nodes.js";

const node = (entity: bigint, stock: number, size: [number, number]): ResourceNodeView => ({
  entity: entity.toString(), kind: "tree_stand", material: "yew-log", name: "Yew log", tier: 2, skill: "Woodcutting", stock, max: 40, size, regrowAt: stock > 0 ? null : 1,
});
const at = (px: number, pz: number) => ({ transform: { px, py: 0, pz } });

describe("ResourceNodes", () => {
  it("picks the nearest node by its edge, within range, and lists the worked-out ones", () => {
    const state = { entities: new Map<bigint, unknown>([[1n, at(0, 0)], [2n, at(10, 0)], [3n, at(30, 0)]]) } as unknown as MirrorState;
    const nodes = new Map([[1n, node(1n, 5, [6, 6])], [2n, node(2n, 0, [2, 2])], [3n, node(3n, 5, [2, 2])]]);
    const r = new ResourceNodes();
    // 4.5 m from the big stand's centre is 1.5 m from its edge; the small one is 4.5 m off.
    r.sync(state, nodes, new THREE.Vector3(4.5, 0, 0), 2.3);
    assert.equal(r.nearest, 1n);
    assert.deepEqual([...r.depleted], [2n]);
    r.sync(state, nodes, new THREE.Vector3(8.5, 0, 0), 2.3);
    assert.equal(r.nearest, 2n, "a worked-out node is still the one in reach (the prompt says so)");
    r.sync(state, nodes, new THREE.Vector3(20, 0, 0), 2.3);
    assert.equal(r.nearest, null);
  });
});
