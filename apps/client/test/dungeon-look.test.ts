/**
 * A dungeon run's look (roadmap D4c, D4e): the sky and weather go while a look applies and
 * come back after; the fog, the dim lights and the shell's matte slot colours follow the
 * look; a small pool of point lights burns on the nearest emitters; a mesh with material
 * slots draws as one group per slot.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { fnv1a32 } from "@mmo-engine/picg";
import type { BodyConfigRow, DungeonLook, TransformRow } from "@mmo-engine/protocol";
import { DungeonAmbience, nearest } from "../src/render/dungeon-look.js";
import { InstancedProps } from "../src/render/instanced-props.js";
import { buildPcgGeometry } from "../src/render/pcg-meshes.js";

const look = (over: Partial<DungeonLook> = {}): DungeonLook => ({
  theme: "grim",
  background: "#050608",
  fog: { color: "#0a0a0c", density: 0.004 },
  hemisphere: { sky: "#303840", ground: "#0a0a0c", intensity: 0.5 },
  dir: { color: "#888888", intensity: 0.2 },
  palette: { floor: "#404040", wall: "#303030", ceiling: "#282828", basin: "#202020" },
  emitters: ["dungeon:torch", "dungeon:brazier"],
  torch: { color: "#ff8c3a", intensity: 70, range: 12, flicker: 0 },
  maxLights: 2,
  ...over,
});

const pointLights = (scene: THREE.Scene): THREE.PointLight[] => scene.children.filter((c): c is THREE.PointLight => c instanceof THREE.PointLight);

describe("nearest", () => {
  it("picks the n points nearest the eye, nearest first", () => {
    const pts: [number, number, number][] = [[10, 0, 0], [1, 0, 0], [5, 0, 0], [3, 0, 0]];
    assert.deepEqual(nearest(pts, { x: 0, y: 0, z: 0 }, 2), [1, 3]);
    assert.deepEqual(nearest(pts, { x: 0, y: 0, z: 0 }, 0), []);
    assert.deepEqual(nearest([], { x: 0, y: 0, z: 0 }, 3), []);
  });
});

describe("DungeonAmbience", () => {
  it("hides the sky while a look applies, sets fog and background, and puts the open world back after", () => {
    const scene = new THREE.Scene();
    const openFog = new THREE.Fog(0xaaccff, 10, 100);
    scene.fog = openFog;
    scene.background = null;
    const sky = new THREE.Group();
    const rain = new THREE.Mesh();
    const a = new DungeonAmbience(scene);
    a.hideWhileLit(sky, rain);
    a.apply(look());
    assert.equal(sky.visible, false);
    assert.equal(rain.visible, false);
    const fog = scene.fog as unknown; // assigned a Fog above, so the compiler has narrowed scene.fog: read it back as what it is now
    assert.ok(fog instanceof THREE.FogExp2 && fog.density === 0.004, "near-black exponential fog");
    assert.ok((scene.background as unknown) instanceof THREE.Color, "the near-black background");
    assert.equal(pointLights(scene).length, 2, "the light pool: maxLights point lights");
    a.apply(null);
    assert.equal(sky.visible, true);
    assert.equal(rain.visible, true);
    assert.equal(scene.fog, openFog, "the open world's fog is back");
    assert.equal(scene.background, null);
    assert.equal(pointLights(scene).length, 0, "no dungeon lights left");
    a.dispose();
  });

  it("names the emitting assets by AssetRef hash, and does nothing for the look already applied", () => {
    const a = new DungeonAmbience(new THREE.Scene());
    const l = look();
    a.apply(l);
    assert.ok(a.emitterHashes.has(fnv1a32("dungeon:torch") >>> 0));
    assert.ok(a.emitterHashes.has(fnv1a32("dungeon:brazier") >>> 0));
    assert.equal(a.emitterHashes.has(fnv1a32("dungeon:pillar") >>> 0), false);
    const lights = pointLights((a as unknown as { scene: THREE.Scene }).scene);
    a.apply(l);
    assert.deepEqual(pointLights((a as unknown as { scene: THREE.Scene }).scene), lights, "the same look again rebuilds nothing");
    a.dispose();
  });

  it("burns its lights on the nearest emitters, easing in, and moves them as the eye moves", () => {
    const scene = new THREE.Scene();
    const a = new DungeonAmbience(scene);
    a.apply(look());
    const emitters: [number, number, number][] = [[2, 2, 0], [30, 2, 0], [-4, 2, 0], [60, 2, 0]];
    a.update({ x: 0, y: 1, z: 0 }, emitters, 1);
    a.update({ x: 0, y: 1, z: 0 }, emitters, 1.25); // one eased step later
    const lit = pointLights(scene).filter((l) => l.intensity > 0);
    assert.equal(lit.length, 2, "two of the four emitters are lit");
    assert.deepEqual(lit.map((l) => l.position.x).sort((x, y) => x - y), [-4, 2], "the nearest two");
    assert.ok(lit.every((l) => Math.abs(l.position.y - 2.2) < 1e-9), "a little above the emitter");
    assert.ok(lit.every((l) => l.intensity <= 70 && l.intensity > 0), "never past the look's torch strength");
    // The eye walks to the far end: the lights follow to the nearest there, the old ones fade out.
    for (let t = 2; t < 6; t += 0.25) a.update({ x: 55, y: 1, z: 0 }, emitters, t);
    const later = pointLights(scene).filter((l) => l.intensity > 1);
    assert.deepEqual(later.map((l) => l.position.x).sort((x, y) => x - y), [30, 60]);
    a.dispose();
  });

  it("gives matte flat-shaded stone per slot in the palette, recoloured live by a look that arrives later", () => {
    const a = new DungeonAmbience(new THREE.Scene());
    const [floor, wall] = a.materialFor(["floor", "wall"]) as THREE.MeshStandardMaterial[];
    assert.equal(floor.roughness, 1);
    assert.equal(floor.metalness, 0);
    assert.equal(floor.flatShading, true);
    assert.equal(a.materialFor(["floor"])[0], floor, "one material per slot");
    a.apply(look());
    assert.equal(floor.color.getHexString(), new THREE.Color("#404040").getHexString());
    assert.equal(wall.color.getHexString(), new THREE.Color("#303030").getHexString());
    a.apply(look({ palette: { floor: "#101010", wall: "#202020", ceiling: "#000000", basin: "#000000" } }));
    assert.equal(floor.color.getHexString(), new THREE.Color("#101010").getHexString());
    a.dispose();
  });
});

describe("InstancedProps for a dungeon", () => {
  const t = (wireId: bigint, x: number): TransformRow => ({ wireId, px: x, py: 2, pz: 3, qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 1, sz: 1 });
  const b = (wireId: bigint): BodyConfigRow => ({ wireId, shapeKind: 0, halfX: 0.1, halfY: 0.3, halfZ: 0.1, radius: 0, mass: 0, friction: 0.5, restitution: 0, motionType: 0, layer: 0 });

  it("reports where the props showing given assets stand, and goes matte", () => {
    const props = new InstancedProps(null);
    props.add(1n, t(1n, 5), b(1n), new THREE.Color(1, 0, 0), { assetHash: fnv1a32("dungeon:torch"), variant: 0 });
    props.add(2n, t(2n, 9), b(2n), new THREE.Color(1, 0, 0), { assetHash: fnv1a32("dungeon:pillar"), variant: 0 });
    props.add(3n, t(3n, 7), b(3n), new THREE.Color(1, 0, 0), null);
    assert.deepEqual(props.positionsOf(new Set([fnv1a32("dungeon:torch") >>> 0])), [[5, 2, 3]]);
    props.matte();
    for (const m of [(props as unknown as { placeholderMaterial: THREE.MeshStandardMaterial }).placeholderMaterial, (props as unknown as { modelMaterial: THREE.MeshStandardMaterial }).modelMaterial]) {
      assert.equal(m.roughness, 1);
      assert.equal(m.metalness, 0);
    }
  });
});

describe("buildPcgGeometry with material slots", () => {
  it("sorts the triangles into one group per slot, and names the slots", () => {
    const position = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 2, 0, 0]);
    // Four triangles; slots by triangle: wall(1), floor(0), wall(1), floor(0).
    const index = new Uint32Array([0, 1, 2, 1, 3, 2, 1, 4, 3, 0, 2, 3]);
    const g = buildPcgGeometry({ position, index, bbox: new Float32Array(6), materials: ["floor", "wall"], triangleMaterial: new Uint32Array([1, 0, 1, 0]) });
    assert.deepEqual(g.groups.map((x) => [x.materialIndex, x.start, x.count]), [[0, 0, 6], [1, 6, 6]]);
    assert.deepEqual([...g.index!.array], [1, 3, 2, 0, 2, 3, 0, 1, 2, 1, 4, 3], "floor triangles first, then walls, each in its own order");
    assert.deepEqual(g.userData.slots, ["floor", "wall"]);
  });

  it("leaves a mesh without slots as one run of indices", () => {
    const g = buildPcgGeometry({ position: new Float32Array(9), index: new Uint32Array([0, 1, 2]), bbox: new Float32Array(6) });
    assert.equal(g.groups.length, 0);
    assert.equal(g.userData.slots, undefined);
  });
});
