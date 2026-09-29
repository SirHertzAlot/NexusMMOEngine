/**
 * EntityLayer: mirror state in, scene out. Moving entities get their own
 * mesh and follow interpolated transforms, the player's position is
 * tracked for the camera, static scenery is batched, chunks go to the
 * terrain, and despawns remove everything. Plus the follow camera.
 */

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { BodyConfigRow, TransformRow } from "@mmo-engine/protocol";
import { Interpolator, MirrorState } from "@mmo-engine/mirror";
import { PlaceholderAssets } from "../src/render/assets.js";
import { EntityLayer } from "../src/render/entity-layer.js";
import { clampCamDistance, followCamera, MAX_CAM_DISTANCE, MIN_CAM_DISTANCE } from "../src/render/follow-camera.js";
import { TerrainRenderer } from "../src/render/terrain/terrain-renderer.js";

/**
 * The FX draw their glow and label textures on a 2D canvas. Node has
 * none, so give it one whose every call does nothing.
 */
before(() => {
  const noop: object = new Proxy(function () {}, {
    get: (_t, key) => (key === "width" || key === "height" ? 64 : noop),
    apply: () => noop,
  });
  (globalThis as { document?: unknown }).document ??= {
    createElement: () => ({ width: 0, height: 0, getContext: () => noop }),
  };
});

const DYNAMIC = 2;
const STATIC = 0;

function transform(wireId: bigint, x: number, z: number): TransformRow {
  return { wireId, px: x, py: 1, pz: z, qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 1, sz: 1 };
}

function body(wireId: bigint, motionType: number): BodyConfigRow {
  return {
    wireId, shapeKind: 0, halfX: 0.5, halfY: 0.5, halfZ: 0.5, radius: 0.5,
    mass: 1, friction: 0.5, restitution: 0, motionType, layer: 1,
  };
}

function setup(): { layer: EntityLayer; state: MirrorState; interp: Interpolator; terrain: TerrainRenderer } {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const terrain = new TerrainRenderer(16);
  const layer = new EntityLayer(scene, camera, new PlaceholderAssets(), terrain);
  scene.add(layer.group);
  return { layer, state: new MirrorState(), interp: new Interpolator(), terrain };
}

/** Entities drawn as their own mesh (placeholder bodies are plain meshes; the batches are a group). */
function ownMeshes(layer: EntityLayer): THREE.Mesh[] {
  return layer.group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
}

/** Instances drawn by the batches. */
function batchedCount(layer: EntityLayer): number {
  let n = 0;
  layer.group.traverse((c) => {
    if (c instanceof THREE.InstancedMesh) n += c.count;
  });
  return n;
}

describe("EntityLayer", () => {
  it("draws a moving entity at its interpolated position and tracks the player", () => {
    const { layer, state, interp } = setup();
    state.entities.set(1n, { wireId: 1n, transform: transform(1n, 10, 20), body: body(1n, DYNAMIC) });
    interp.push(1, [transform(1n, 10, 20)]);
    interp.push(2, [transform(1n, 12, 20)]);

    layer.sync(state, interp, 0.5, 1n);
    const meshes = ownMeshes(layer);
    assert.equal(meshes.length, 1);
    assert.deepEqual(meshes[0].position.toArray(), [11, 1, 20], "halfway between the two ticks");
    assert.deepEqual(layer.player?.toArray(), [11, 1, 20]);

    layer.sync(state, interp, 1, null);
    assert.equal(layer.player, null, "no player wire id, no player position");
    layer.dispose();
  });

  it("batches static scenery instead of giving it a mesh", () => {
    const { layer, state, interp } = setup();
    for (let i = 1n; i <= 50n; i++) {
      state.entities.set(i, { wireId: i, transform: transform(i, Number(i), 0), body: body(i, STATIC) });
    }
    layer.sync(state, interp, 1, null);
    assert.equal(ownMeshes(layer).length, 0);
    assert.equal(batchedCount(layer), 50);
    layer.dispose();
  });

  it("hands chunks to the terrain and removes everything when it despawns", () => {
    const { layer, state, interp, terrain } = setup();
    state.entities.set(1n, { wireId: 1n, transform: transform(1n, 0, 0), body: body(1n, DYNAMIC) });
    state.entities.set(2n, { wireId: 2n, chunk: { wireId: 2n, chunkId: 0n, seed: 1n, lod: 0, heights: null } });
    layer.sync(state, interp, 1, null);
    assert.deepEqual([...terrain.chunkWireIds()], [2n]);
    assert.equal(ownMeshes(layer).length, 1);

    state.entities.clear();
    layer.sync(state, interp, 1, null);
    assert.deepEqual([...terrain.chunkWireIds()], []);
    assert.equal(ownMeshes(layer).length, 0);
    layer.dispose();
    terrain.dispose();
  });

  it("hover picks the entity under the ray", () => {
    const { layer, state, interp } = setup();
    state.entities.set(7n, { wireId: 7n, transform: transform(7n, 5, 5), body: body(7n, DYNAMIC) });
    layer.sync(state, interp, 1, null);
    const mesh = ownMeshes(layer)[0];
    mesh.updateMatrixWorld();
    const emissive = (): number => (mesh.material as THREE.MeshStandardMaterial).emissive.getHex();

    layer.hover(new THREE.Raycaster(new THREE.Vector3(5, 50, 5), new THREE.Vector3(0, -1, 0)));
    layer.sync(state, interp, 1, null);
    assert.notEqual(emissive(), 0, "hovered: tinted");

    layer.hover(new THREE.Raycaster(new THREE.Vector3(50, 50, 50), new THREE.Vector3(0, -1, 0)));
    layer.sync(state, interp, 1, null);
    assert.equal(emissive(), 0, "nothing under the ray: plain");
    layer.dispose();
  });
});

describe("followCamera", () => {
  it("sits behind the target at the given distance and looks at it", () => {
    const camera = new THREE.PerspectiveCamera();
    const target = new THREE.Vector3(100, 10, 200);
    followCamera(camera, target, 0, 0, 9);
    assert.ok(Math.abs(camera.position.x - 100) < 1e-9);
    assert.ok(Math.abs(camera.position.z - (200 - 9)) < 1e-9, "yaw 0 faces +z, so the camera is at -z");
    assert.ok(Math.abs(camera.position.y - 11.2) < 1e-9);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    assert.ok(forward.z > 0.99, "looking towards the target");
  });

  it("never dips below the target's head, and clamps the distance", () => {
    const camera = new THREE.PerspectiveCamera();
    followCamera(camera, new THREE.Vector3(0, 5, 0), 0, -1.2, 9);
    assert.ok(camera.position.y >= 5.6 - 1e-9);
    assert.equal(clampCamDistance(1), MIN_CAM_DISTANCE);
    assert.equal(clampCamDistance(100), MAX_CAM_DISTANCE);
    assert.equal(clampCamDistance(10), 10);
  });
});
