/**
 * WaterRenderer — the sea and lakes, from the welcome's world map.
 *
 *  - One flat sheet per wet map cell at its surface height (the map's
 *    water layer already reaches a cell past the shore). The ground hides
 *    whatever lies under the land, so the shoreline is the terrain's own,
 *    at chunk detail near the player and map detail far away.
 *  - Past the world's edge the sea runs on to the horizon, wherever the
 *    map's edge is sea (the land running off the north stays open).
 *  - The look (waves, sky reflection, sun glint, depth colour, shore foam,
 *    fog) is water-material.ts, reflecting the DaySky's own sky.
 *
 * Worlds without a water layer (older servers) get no water.
 */

import * as THREE from "three";
import type { WorldMap } from "@mmo-engine/protocol";
import { createSkyUniforms, type SkyUniforms } from "./sky/sky-glsl.js";
import { createWaterMaterial, waterDepthRect, waterDepthTexture, type WaterUniforms } from "./water-material.js";

/** How far the open sea runs past the world's edge, metres. */
export const SEA_REACH = 12_000;
/** Edge cells within this of sea level count as open sea (not a lake at the edge). */
const SEA_TOLERANCE = 0.5;

/**
 * The water surface as triangles: a quad per wet cell, plus strips of open
 * sea beyond the edges (and corners) where the map's edge is sea. Null
 * when the map has no water.
 */
export function waterGeometry(map: WorldMap, seaLevel: number | null, reach = SEA_REACH): THREE.BufferGeometry | null {
  const water = map.water;
  if (!water) return null;
  const { width: W, depth: D, cell } = map;
  const pos: number[] = [];
  const quad = (x0: number, z0: number, x1: number, z1: number, y: number): void => {
    // Two triangles facing up (+y): counter-clockwise seen from above.
    pos.push(x0, y, z0, x0, y, z1, x1, y, z0);
    pos.push(x1, y, z0, x0, y, z1, x1, y, z1);
  };
  const x0Of = (u: number): number => map.originX + (u - 0.5) * cell;
  const z0Of = (v: number): number => map.originZ + (v - 0.5) * cell;
  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      const y = water[v * W + u];
      if (!Number.isNaN(y)) quad(x0Of(u), z0Of(v), x0Of(u + 1), z0Of(v + 1), y);
    }
  }
  if (seaLevel !== null) {
    const open = (u: number, v: number): boolean => {
      const y = water[v * W + u];
      return !Number.isNaN(y) && Math.abs(y - seaLevel) <= SEA_TOLERANCE;
    };
    const [xMin, xMax, zMin, zMax] = [x0Of(0), x0Of(W), z0Of(0), z0Of(D)];
    for (let u = 0; u < W; u++) {
      if (open(u, 0)) quad(x0Of(u), zMin - reach, x0Of(u + 1), zMin, seaLevel);
      if (open(u, D - 1)) quad(x0Of(u), zMax, x0Of(u + 1), zMax + reach, seaLevel);
    }
    for (let v = 0; v < D; v++) {
      if (open(0, v)) quad(xMin - reach, z0Of(v), xMin, z0Of(v + 1), seaLevel);
      if (open(W - 1, v)) quad(xMax, z0Of(v), xMax + reach, z0Of(v + 1), seaLevel);
    }
    if (open(0, 0)) quad(xMin - reach, zMin - reach, xMin, zMin, seaLevel);
    if (open(W - 1, 0)) quad(xMax, zMin - reach, xMax + reach, zMin, seaLevel);
    if (open(0, D - 1)) quad(xMin - reach, zMax, xMin, zMax + reach, seaLevel);
    if (open(W - 1, D - 1)) quad(xMax, zMax, xMax + reach, zMax + reach, seaLevel);
  }
  if (pos.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(pos), 3));
  const normals = new Float32Array(pos.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The water surface height at world (x, z), from the map cell under it;
 * null on dry ground. Beyond the map's edge the open sea continues where
 * the edge cell is sea, as waterGeometry draws it.
 */
export function waterSurfaceAt(map: WorldMap, seaLevel: number | null, x: number, z: number): number | null {
  const water = map.water;
  if (!water) return null;
  const { width: W, depth: D, cell } = map;
  const u = Math.round((x - map.originX) / cell);
  const v = Math.round((z - map.originZ) / cell);
  const inside = u >= 0 && u < W && v >= 0 && v < D;
  const y = water[Math.min(D - 1, Math.max(0, v)) * W + Math.min(W - 1, Math.max(0, u))];
  if (Number.isNaN(y)) return null;
  if (inside) return y;
  return seaLevel !== null && Math.abs(y - seaLevel) <= SEA_TOLERANCE ? seaLevel : null;
}

export class WaterRenderer {
  readonly group = new THREE.Group();
  private readonly uniforms: WaterUniforms;
  private readonly material: THREE.ShaderMaterial;
  private mesh: THREE.Mesh | null = null;
  private depthMap: THREE.DataTexture | null = null;
  private world: { map: WorldMap; seaLevel: number | null } | null = null;

  /** @param sky the DaySky's uniforms, so the water reflects that sky (default: a fixed midday). */
  constructor(sky: SkyUniforms = createSkyUniforms()) {
    this.group.name = "water";
    const { material, uniforms } = createWaterMaterial(sky);
    this.material = material;
    this.uniforms = uniforms;
  }

  /** Whether any water is on screen (tests, HUD). */
  get hasWater(): boolean {
    return this.mesh !== null;
  }

  /** The world's water (replaces any previous world); null clears it. */
  setWorld(map: WorldMap | null, seaLevel: number | null): void {
    this.clear();
    this.world = map ? { map, seaLevel } : null;
    const geometry = map ? waterGeometry(map, seaLevel) : null;
    if (!geometry || !map) return;
    this.depthMap = waterDepthTexture(map);
    this.uniforms.uDepthMap.value = this.depthMap;
    this.uniforms.uDepthRect.value = waterDepthRect(map);
    this.uniforms.uHasDepth.value = this.depthMap ? 1 : 0;
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = "water-surface";
    // Drawn after the opaque world; the ground under it shows through.
    this.mesh.renderOrder = 1;
    this.group.add(this.mesh);
  }

  /** The water surface height at world (x, z), or null on dry ground (see waterSurfaceAt). */
  surfaceAt(x: number, z: number): number | null {
    return this.world ? waterSurfaceAt(this.world.map, this.world.seaLevel, x, z) : null;
  }

  /** Once per frame: move the waves. */
  update(timeSeconds: number): void {
    this.uniforms.uTime.value = timeSeconds;
  }

  /** Rain ripples (WX1): 0 = calm, 1 = heavy rain. Driven by the weather field. */
  setRainIntensity(v: number): void {
    this.uniforms.uRainIntensity.value = v;
  }

  setWireframe(on: boolean): void {
    this.material.wireframe = on;
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }

  private clear(): void {
    this.depthMap?.dispose();
    this.depthMap = null;
    this.uniforms.uDepthMap.value = null;
    this.uniforms.uHasDepth.value = 0;
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh = null;
  }
}
