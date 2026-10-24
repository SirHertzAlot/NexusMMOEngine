import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TelegraphMessage } from "@mmo-engine/protocol";
import { Telegraphs, TELEGRAPH_POOL } from "../src/render/telegraphs.js";

const ground = (): number => 2;
const cone = (id: number, state: TelegraphMessage["state"] = "warned"): TelegraphMessage => ({
  kind: "telegraph", tick: 1, id, source: "7", state, ticksUntilHit: 30,
  shape: { kind: "cone", x: 1, z: 2, yaw: 0, range: 6, halfAngle: 0.7 },
});

describe("Telegraphs", () => {
  it("fills over the cast time, then fades out once it lands", () => {
    const t = new Telegraphs();
    t.apply(cone(1), 30, ground, 10);
    const mesh = t.group.children[0] as unknown as { visible: boolean; position: { y: number }; material: { uniforms: Record<string, { value: number }> } };
    assert.equal(mesh.visible, true);
    assert.ok(mesh.position.y > 2);
    t.update(10.5);
    assert.ok(Math.abs(mesh.material.uniforms.uFill.value - 0.5) < 1e-9);
    t.apply(cone(1, "resolved"), 30, ground, 11);
    t.update(11.1);
    assert.ok(mesh.material.uniforms.uAlpha.value > 0 && mesh.material.uniforms.uAlpha.value < 1);
    t.update(12);
    assert.equal(t.active, 0);
    assert.equal(mesh.visible, false);
  });

  it("reuses a fixed pool", () => {
    const t = new Telegraphs();
    for (let i = 0; i < TELEGRAPH_POOL + 5; i++) t.apply(cone(i), 30, ground, i * 0.01);
    assert.equal(t.active, TELEGRAPH_POOL);
    assert.equal(t.group.children.length, TELEGRAPH_POOL);
  });
});
