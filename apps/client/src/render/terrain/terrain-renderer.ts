/**
 * TerrainRenderer — everything the player sees of the ground.
 *
 *  - Near: the streamed chunks (the server's exact 16x16 tiles), in LOD
 *    rings round the camera and merged into one mesh per 4x4-chunk block
 *    (terrain-lod.ts), all sharing one opaque material; normals match
 *    across chunk borders and are recomputed at the borders as neighbours
 *    come and go.
 *  - Far: one mesh of the whole world from the welcome's coarse map (16 m
 *    cells), so mountains show on the horizon long before their chunks
 *    stream in. It hides itself wherever a chunk is loaded (a mask texture
 *    with one texel per world chunk), so near and far never overlap.
 *  - Ground colours per biome and the snow line come from the same map.
 *
 * Legacy worlds (no world info): chunks only, default ground colour.
 */

import * as THREE from "three";
import type { ChunkRange, ChunkRow, WorldMap } from "@mmo-engine/protocol";
import { tileHeightAt } from "@mmo-engine/protocol";
import type { WorkerRequester } from "../../workers/pool.js";
import { groundColors, snowLine } from "./ground.js";
import { chunkNormals, SIDE } from "./terrain-mesh.js";
import { BLOCK, blockGeometry, blockOf, buildBlockGeometry, chunkCost, ringOf, strideForRing, type LodChunk } from "./terrain-lod.js";
import { createTerrainMaterial, createTerrainUniforms, NO_SEA, NO_SNOW } from "./terrain-material.js";
import { surfaceLayerMap, type Surfaces } from "./surfaces.js";

/** Decode chunk (cx, cz) from the chunkId u64 (see spawnChunk/chunkIdFor). */
export function chunkCoords(chunkId: bigint): { cx: number; cz: number } {
  const u = (v: bigint): number => {
    const n = Number(v & 0xffffffffn);
    return n >= 0x80000000 ? n - 0x100000000 : n;
  };
  return { cx: u(chunkId >> 32n), cz: u(chunkId) };
}

interface NearChunk {
  wireId: bigint;
  cx: number;
  cz: number;
  heights: Float32Array;
  /** False for a flat stand-in (the chunk arrived without heights). */
  displaced: boolean;
  /** SIDE * SIDE unit normals (xyz), refined as neighbours arrive. */
  normals: Float32Array;
  /** Sample stride for its LOD ring (terrain-lod.ts). */
  stride: number;
}

interface Block {
  mesh: THREE.Mesh | null;
  dirty: boolean;
  /** Bumped per rebuild: a worker's answer for an older one is dropped. */
  gen: number;
}

/** What the near terrain costs to draw (perf HUD, tests). */
export interface TerrainStats {
  chunks: number;
  /** Near meshes: one per block. */
  drawCalls: number;
  triangles: number;
  /** Chunk count by sample stride. */
  chunksPerStride: Record<number, number>;
}

interface LoadedMask {
  texture: THREE.DataTexture;
  data: Uint8Array;
  bounds: ChunkRange;
  width: number;
}

const key = (cx: number, cz: number): string => `${cx},${cz}`;
const blockKey = (cx: number, cz: number): string => `${blockOf(cx)},${blockOf(cz)}`;
const EDGE_NEIGHBOURS: ReadonlyArray<[number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]];

export class TerrainRenderer {
  readonly group = new THREE.Group();
  private readonly uniforms = createTerrainUniforms();
  private readonly nearMaterial = createTerrainMaterial(this.uniforms);
  private readonly farMaterial = createTerrainMaterial(this.uniforms, true);
  private readonly chunks = new Map<string, NearChunk>();
  private readonly keyOfWire = new Map<bigint, string>();
  private readonly blocks = new Map<string, Block>();
  /** The camera's chunk; null until the first update with a camera (everything full detail). */
  private camChunk: { cx: number; cz: number } | null = null;
  private far: THREE.Mesh | null = null;
  private ground: THREE.DataTexture | null = null;
  private mask: LoadedMask | null = null;
  private maskDirty = false;
  private readonly spacing: number;
  private map: WorldMap | null = null;
  private surfaces: Surfaces | null = null;
  private layerMap: THREE.DataTexture | null = null;

  /** `workers`: build block meshes off the main thread; without, update() builds them inline. */
  constructor(private readonly chunkWorldSize: number, private readonly workers?: WorkerRequester) {
    this.spacing = chunkWorldSize / (SIDE - 1);
    this.group.name = "terrain";
  }

  /** Chunks on screen (tests, HUD). */
  get chunkCount(): number {
    return this.chunks.size;
  }

  get hasFar(): boolean {
    return this.far !== null;
  }

  /**
   * The baked world's coarse map, chunk range, and sea level (from the
   * welcome), or null for a legacy world. Replaces any previous world.
   */
  setWorld(world: { map: WorldMap; bounds: ChunkRange; seaLevel?: number | null } | null): void {
    this.disposeWorld();
    if (!world) {
      this.applySurfaces();
      return;
    }
    const { map, bounds } = world;
    this.map = map;
    this.uniforms.uFarCell.value = map.cell;
    this.uniforms.uSeaLevel.value = world.seaLevel ?? NO_SEA;

    this.ground = new THREE.DataTexture(groundColors(map), map.width, map.depth, THREE.RGBAFormat);
    this.ground.colorSpace = THREE.SRGBColorSpace;
    this.ground.magFilter = THREE.LinearFilter;
    this.ground.minFilter = THREE.LinearFilter;
    this.ground.needsUpdate = true;
    this.uniforms.uGround.value = this.ground;
    this.uniforms.uHasGround.value = 1;
    // Texel centres sit on map cells: the rect starts half a cell early.
    this.uniforms.uGroundRect.value.set(
      map.originX - map.cell / 2,
      map.originZ - map.cell / 2,
      map.width * map.cell,
      map.depth * map.cell,
    );
    let maxHeight = -Infinity;
    for (const h of map.heights) maxHeight = Math.max(maxHeight, h);
    const line = snowLine(maxHeight);
    this.uniforms.uSnowLine.value = Number.isFinite(line) ? line : NO_SNOW;

    const width = bounds.maxCx - bounds.minCx + 1;
    const depth = bounds.maxCz - bounds.minCz + 1;
    const data = new Uint8Array(width * depth);
    const texture = new THREE.DataTexture(data, width, depth, THREE.RedFormat, THREE.UnsignedByteType);
    // One byte per texel: rows are `width` bytes, not padded to WebGL's
    // default 4-byte alignment (a 250-chunk world would read skewed rows,
    // cutting the horizon open in the wrong places).
    texture.unpackAlignment = 1;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    this.mask = { texture, data, bounds, width };
    this.uniforms.uLoaded.value = texture;
    const s = this.chunkWorldSize;
    this.uniforms.uLoadedRect.value.set(bounds.minCx * s, bounds.minCz * s, width * s, depth * s);
    for (const c of this.chunks.values()) this.markLoaded(c.cx, c.cz, c.displaced);

    this.far = new THREE.Mesh(farGeometry(map), this.farMaterial);
    this.far.name = "terrain-far";
    this.group.add(this.far);
    this.applySurfaces();
  }

  /**
   * Textured ground (surfaces.ts), or null for the flat biome colours.
   * The terrain doesn't own them: the caller disposes them.
   */
  setSurfaces(surfaces: Surfaces | null): void {
    this.surfaces = surfaces;
    this.applySurfaces();
  }

  /** Whether the ground is textured now (tests, HUD). */
  get textured(): boolean {
    return this.layerMap !== null;
  }

  /**
   * Show a chunk entity's terrain. Idempotent per wire id; a chunk that
   * arrived flat (no heights) is rebuilt once its heights arrive.
   */
  ensureChunk(wireId: bigint, chunk: ChunkRow): void {
    const known = this.keyOfWire.get(wireId);
    // A wire id can outlive its chunk (a newer entity took the cell, then went): rebuild it then.
    const c = known === undefined ? undefined : this.chunks.get(known);
    if (c && (c.displaced || chunk.heights === null)) return;
    const { cx, cz } = chunkCoords(chunk.chunkId);
    const k = key(cx, cz);
    const displaced = chunk.heights !== null && chunk.heights.length === SIDE * SIDE;
    const heights = displaced ? chunk.heights! : new Float32Array(SIDE * SIDE);
    const normals = new Float32Array(SIDE * SIDE * 3);
    this.chunks.set(k, { wireId, cx, cz, heights, displaced, normals, stride: this.strideAt(cx, cz) });
    this.keyOfWire.set(wireId, k);
    this.refreshNormals(cx, cz, true);
    this.markLoaded(cx, cz, displaced);
  }

  /** Drop a chunk entity's terrain (despawned: unloaded server-side). */
  removeChunk(wireId: bigint): void {
    const k = this.keyOfWire.get(wireId);
    if (k === undefined) return;
    this.keyOfWire.delete(wireId);
    const c = this.chunks.get(k);
    if (!c || c.wireId !== wireId) return;
    this.chunks.delete(k);
    this.markBlock(c.cx, c.cz);
    this.markLoaded(c.cx, c.cz, false);
    this.refreshNormals(c.cx, c.cz, false);
  }

  /** Wire ids of the chunk entities on screen. */
  chunkWireIds(): IterableIterator<bigint> {
    return this.keyOfWire.keys();
  }

  /**
   * Once per frame: move chunks to the LOD ring the camera (world x, z) puts
   * them in, rebuild the blocks that changed, and upload the loaded-chunk
   * mask if it changed. Without a camera every chunk stays full detail.
   */
  update(camera?: { x: number; z: number }): void {
    if (camera) {
      const cx = Math.floor(camera.x / this.chunkWorldSize);
      const cz = Math.floor(camera.z / this.chunkWorldSize);
      if (!this.camChunk || this.camChunk.cx !== cx || this.camChunk.cz !== cz) {
        this.camChunk = { cx, cz };
        for (const c of this.chunks.values()) {
          const stride = this.strideAt(c.cx, c.cz);
          if (stride !== c.stride) {
            c.stride = stride;
            this.markBlock(c.cx, c.cz);
          }
        }
      }
    }
    for (const [bk, b] of this.blocks) if (b.dirty) this.rebuildBlock(bk, b);
    if (this.maskDirty && this.mask) {
      this.mask.texture.needsUpdate = true;
      this.maskDirty = false;
    }
  }

  /** Near-terrain cost (perf HUD, tests); current as of the last update(). */
  get stats(): TerrainStats {
    let drawCalls = 0;
    let triangles = 0;
    for (const b of this.blocks.values()) if (b.mesh) drawCalls++;
    const chunksPerStride: Record<number, number> = {};
    for (const c of this.chunks.values()) {
      chunksPerStride[c.stride] = (chunksPerStride[c.stride] ?? 0) + 1;
      triangles += chunkCost(c.stride).triangles;
    }
    return { chunks: this.chunks.size, drawCalls, triangles, chunksPerStride };
  }

  setWireframe(on: boolean): void {
    this.nearMaterial.wireframe = on;
    this.farMaterial.wireframe = on;
  }

  /** The loaded chunk under world (x, z), or null (tests, tools). */
  loadedChunkAt(x: number, z: number): { cx: number; cz: number } | null {
    const cx = Math.floor(x / this.chunkWorldSize);
    const cz = Math.floor(z / this.chunkWorldSize);
    return this.chunks.has(key(cx, cz)) ? { cx, cz } : null;
  }

  /**
   * The ground height at world (x, z) on the loaded terrain (the same
   * triangles the server's height field and the mesh use), or null
   * where no chunk with heights is loaded.
   */
  heightAt(x: number, z: number): number | null {
    const cx = Math.floor(x / this.chunkWorldSize);
    const cz = Math.floor(z / this.chunkWorldSize);
    const c = this.chunks.get(key(cx, cz));
    if (!c || !c.displaced) return null;
    return tileHeightAt(c.heights, x - cx * this.chunkWorldSize, z - cz * this.chunkWorldSize, this.chunkWorldSize);
  }

  /** The full-detail normals of a loaded chunk (tests). */
  normalsOf(cx: number, cz: number): Float32Array | null {
    return this.chunks.get(key(cx, cz))?.normals ?? null;
  }

  /** Whether the far horizon hides itself over chunk (cx, cz) (tests). */
  maskedAt(cx: number, cz: number): boolean {
    const m = this.mask;
    if (!m) return false;
    return m.data[(cz - m.bounds.minCz) * m.width + (cx - m.bounds.minCx)] === 255;
  }

  dispose(): void {
    for (const b of this.blocks.values()) this.dropBlockMesh(b);
    this.blocks.clear();
    this.chunks.clear();
    this.keyOfWire.clear();
    this.disposeWorld();
    this.nearMaterial.dispose();
    this.farMaterial.dispose();
  }

  // ------------------------------------------------------------ internals

  /** Recompute normals of (cx, cz) (when `self`) and its edge neighbours. */
  private refreshNormals(cx: number, cz: number, self: boolean): void {
    if (self) this.computeNormals(cx, cz);
    for (const [dx, dz] of EDGE_NEIGHBOURS) this.computeNormals(cx + dx, cz + dz);
  }

  private computeNormals(cx: number, cz: number): void {
    const c = this.chunks.get(key(cx, cz));
    if (!c) return;
    chunkNormals(
      c.heights,
      (dx, dz) => this.chunks.get(key(cx + dx, cz + dz))?.heights ?? null,
      this.spacing,
      c.normals,
    );
    this.markBlock(cx, cz);
  }

  private strideAt(cx: number, cz: number): number {
    return this.camChunk ? strideForRing(ringOf(cx, cz, this.camChunk.cx, this.camChunk.cz)) : 1;
  }

  private markBlock(cx: number, cz: number): void {
    const bk = blockKey(cx, cz);
    const b = this.blocks.get(bk);
    if (b) b.dirty = true;
    else this.blocks.set(bk, { mesh: null, dirty: true, gen: 0 });
  }

  private rebuildBlock(bk: string, b: Block): void {
    b.dirty = false;
    const gen = ++b.gen;
    const [bx, bz] = bk.split(",").map(Number);
    const members: LodChunk[] = [];
    for (let dz = 0; dz < BLOCK; dz++) {
      for (let dx = 0; dx < BLOCK; dx++) {
        const c = this.chunks.get(key(bx * BLOCK + dx, bz * BLOCK + dz));
        if (c) members.push(c);
      }
    }
    if (members.length === 0) {
      this.dropBlockMesh(b);
      this.blocks.delete(bk);
      return;
    }
    const ox = bx * BLOCK * this.chunkWorldSize;
    const oz = bz * BLOCK * this.chunkWorldSize;
    const inline = (): void => this.installBlock(bk, b, buildBlockGeometry(members, this.chunkWorldSize, ox, oz), ox, oz);
    if (!this.workers) return inline();
    // The worker takes copies (it owns what it is sent); the old mesh stays up until the new one lands.
    const chunks = members.map((c) => ({ cx: c.cx, cz: c.cz, stride: c.stride, heights: c.heights.slice(), normals: c.normals.slice() }));
    this.workers
      .request("terrainBlock", { chunks, chunkWorldSize: this.chunkWorldSize, originX: ox, originZ: oz })
      .then(
        (r) => b.gen === gen && this.blocks.get(bk) === b && this.installBlock(bk, b, blockGeometry(r), ox, oz),
        (err: unknown) => {
          console.warn(`[terrain] block ${bk} worker failed; building inline:`, (err as Error).message);
          if (b.gen === gen && this.blocks.get(bk) === b) inline();
        },
      );
  }

  private installBlock(bk: string, b: Block, geometry: THREE.BufferGeometry, ox: number, oz: number): void {
    this.dropBlockMesh(b);
    const mesh = new THREE.Mesh(geometry, this.nearMaterial);
    mesh.position.set(ox, 0, oz);
    mesh.name = `terrain block ${bk}`;
    this.group.add(mesh);
    b.mesh = mesh;
  }

  private dropBlockMesh(b: Block): void {
    if (!b.mesh) return;
    this.group.remove(b.mesh);
    b.mesh.geometry.dispose();
    b.mesh = null;
  }

  private markLoaded(cx: number, cz: number, on: boolean): void {
    const m = this.mask;
    if (!m) return;
    const { bounds: b } = m;
    if (cx < b.minCx || cx > b.maxCx || cz < b.minCz || cz > b.maxCz) return;
    m.data[(cz - b.minCz) * m.width + (cx - b.minCx)] = on ? 255 : 0;
    this.maskDirty = true;
  }

  /** Bind the surfaces to the materials when there are both surfaces and a world map. */
  private applySurfaces(): void {
    this.layerMap?.dispose();
    this.layerMap = null;
    const s = this.surfaces;
    const on = s !== null && this.map !== null;
    if (s && this.map) {
      const map = this.map;
      const tex = new THREE.DataTexture(surfaceLayerMap(map, s.manifest), map.width, map.depth, THREE.RedFormat, THREE.UnsignedByteType);
      tex.unpackAlignment = 1;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.needsUpdate = true;
      this.layerMap = tex;
      const u = this.uniforms;
      u.uSurfAlbedo.value = s.albedo;
      u.uSurfProps.value = s.props;
      u.uSurfLayers.value = tex;
      u.uSurfLayersSize.value.set(map.width, map.depth);
      s.manifest.layers.forEach((l, i) => {
        u.uSurfTile.value[i] = l.tileMetres;
        u.uSurfTint.value[i].set(...l.tint);
      });
      const index = (id: string): number => s.manifest.layers.findIndex((l) => l.id === id);
      u.uSurfRock.value = index(s.manifest.rock);
      u.uSurfSnow.value = index(s.manifest.snow);
    } else {
      this.uniforms.uSurfAlbedo.value = null;
      this.uniforms.uSurfProps.value = null;
      this.uniforms.uSurfLayers.value = null;
    }
    for (const m of [this.nearMaterial, this.farMaterial]) {
      const defines = { ...(m.defines ?? {}) };
      if (on) defines.TERRAIN_SURFACES = "";
      else delete defines.TERRAIN_SURFACES;
      m.defines = defines;
      m.needsUpdate = true;
    }
  }

  private disposeWorld(): void {
    this.map = null;
    this.layerMap?.dispose();
    this.layerMap = null;
    if (this.far) {
      this.group.remove(this.far);
      this.far.geometry.dispose();
      this.far = null;
    }
    this.ground?.dispose();
    this.ground = null;
    this.mask?.texture.dispose();
    this.mask = null;
    this.uniforms.uGround.value = null;
    this.uniforms.uHasGround.value = 0;
    this.uniforms.uLoaded.value = null;
    this.uniforms.uSnowLine.value = NO_SNOW;
    this.uniforms.uSeaLevel.value = NO_SEA;
    this.uniforms.uSurfLayers.value = null;
  }
}

/** The whole world at the map's resolution: one vertex per map cell. */
export function farGeometry(map: WorldMap): THREE.BufferGeometry {
  const { width: W, depth: D } = map;
  const pos = new Float32Array(W * D * 3);
  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      const k = 3 * (v * W + u);
      pos[k] = map.originX + u * map.cell;
      pos[k + 1] = map.heights[v * W + u];
      pos[k + 2] = map.originZ + v * map.cell;
    }
  }
  const idx = new Uint32Array((W - 1) * (D - 1) * 6);
  let t = 0;
  for (let v = 0; v < D - 1; v++) {
    for (let u = 0; u < W - 1; u++) {
      const a = v * W + u;
      const b = a + 1;
      const c = a + W;
      const d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = d; idx[t++] = b; idx[t++] = c;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(new THREE.BufferAttribute(idx, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
