/**
 * Asset pipeline hooks (Phase 3: placeholder visuals).
 *
 * Joey supplies the real art assets later; the pack contract now lives
 * in @mmo-engine/art (manifest schema, validation, ManifestAssetProvider
 * with per-asset placeholder fallback). This module keeps the
 * PlaceholderAssets renderer the game client uses until a pack ships —
 * it implements the shared AssetProvider interface, so swapping in the
 * manifest provider is a one-line change in App.tsx.
 */

import * as THREE from "three";
import { ShapeKind } from "@mmo-engine/schema/generated/js/mmo-engine.js";
import type { BodyConfigRow, ChunkRow } from "@mmo-engine/protocol";
import type { AssetProvider } from "@mmo-engine/art/browser";
import { applyTerrainFx } from "./terrain-fx.js";

export type { AssetProvider };
export {
  ManifestAssetProvider,
  type AssetManifest,
  type AssetLoadStatus,
} from "@mmo-engine/art/browser";

/** Deterministic placeholder color per entity (HSL from wire id hash). */
export function placeholderColor(wireId: bigint): THREE.Color {
  let h = 0n;
  let x = wireId === 0n ? 0x9e3779b97f4a7c15n : wireId;
  for (let i = 0; i < 4; i++) {
    h ^= x & 0xffffn;
    x >>= 16n;
  }
  return new THREE.Color().setHSL(Number(h % 360n) / 360, 0.55, 0.5);
}

/** Decode chunk (cx, cz) from the chunkId u64 (see spawnChunk/chunkIdFor). */
export function chunkCoords(chunkId: bigint): { cx: number; cz: number } {
  const u = (v: bigint): number => {
    const n = Number(v & 0xffffffffn);
    return n >= 0x80000000 ? n - 0x100000000 : n;
  };
  return { cx: u(chunkId >> 32n), cz: u(chunkId) };
}

export class PlaceholderAssets implements AssetProvider {
  private wireframeTerrain = false;
  private readonly terrainMaterials = new Set<THREE.MeshStandardMaterial>();

  setTerrainWireframe(on: boolean): void {
    this.wireframeTerrain = on;
    for (const m of this.terrainMaterials) m.wireframe = on;
  }

  bodyMesh(body: BodyConfigRow): THREE.Object3D {
    let geometry: THREE.BufferGeometry;
    if (body.shapeKind === ShapeKind.Sphere) {
      geometry = new THREE.SphereGeometry(Math.max(body.radius, 0.05), 24, 18);
    } else if (body.shapeKind === ShapeKind.Capsule) {
      // Upright, standing on the entity's position (a character's feet), as the physics body does.
      const r = Math.max(body.radius, 0.05);
      const half = Math.max(body.halfY, 0);
      geometry = new THREE.CapsuleGeometry(r, half * 2, 6, 16);
      geometry.translate(0, half + r, 0);
    } else {
      geometry = new THREE.BoxGeometry(
        Math.max(body.halfX * 2, 0.05),
        Math.max(body.halfY * 2, 0.05),
        Math.max(body.halfZ * 2, 0.05),
      );
    }
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.7,
      metalness: 0.1,
    });
    return new THREE.Mesh(geometry, material);
  }

  terrainMesh(chunk: ChunkRow, worldSize: number): THREE.Object3D {
    const { cx, cz } = chunkCoords(chunk.chunkId);
    // Heightfield-displaced terrain (slice 4.1): the server attaches an
    // authoritative 16x16 heightmap on network snapshots/deltas. Build
    // the plane with 15 segments so the 16x16 vertices map 1:1 to samples
    // (vertex v ↔ heights[v]); without heights (old snapshots) it stays
    // a flat plane as before.
    //
    // Seamless tiling: the 16 samples span the FULL 16-unit chunk
    // (sample i ↔ local position i*16/15), so adjacent chunks share
    // boundary geometry with no gaps. The server's CharacterSystem uses
    // the same mapping for ground height.
    const S = 16;
    const size = worldSize;
    const geometry = new THREE.PlaneGeometry(size, size, S - 1, S - 1);
    geometry.rotateX(-Math.PI / 2);
    const h = chunk.heights;
    if (h !== null && h.length === S * S) {
      const pos = geometry.attributes.position as THREE.BufferAttribute;
      for (let v = 0; v < S * S; v++) pos.setY(v, h[v]);
      pos.needsUpdate = true;
      geometry.computeVertexNormals();
    }
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x3d6b35),
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 0.92,
      wireframe: this.wireframeTerrain,
    });
    const mesh = new THREE.Mesh(geometry, material);
    this.terrainMaterials.add(material);
    // Forget disposed chunks (despawn / rebuild), or the set grows forever.
    material.addEventListener("dispose", () => this.terrainMaterials.delete(material));
    // Animated placeholder FX: albedo patches, energy veins, water
    // shimmer — fragment-only, physics stays authoritative.
    applyTerrainFx(material, Number(chunk.seed & 0xffffffffn));
    mesh.position.set(
      cx * worldSize + size / 2,
      0,
      cz * worldSize + size / 2,
    );
    return mesh;
  }

  async loadAssetPack(_url: string): Promise<void> {
    // Stub: the real art pipeline (glTF/texture manifest) lands here.
    // The renderer never calls this yet; it exists so the App can wire
    // Joey's assets later without changing the render loop.
    return Promise.resolve();
  }
}
