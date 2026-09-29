/**
 * WaterRenderer — the sea and lakes, from the welcome's world map.
 *
 *  - One flat sheet per wet map cell at its surface height (the map's
 *    water layer already reaches a cell past the shore). The ground hides
 *    whatever lies under the land, so the shoreline is the terrain's own,
 *    at chunk detail near the player and map detail far away.
 *  - Past the world's edge the sea runs on to the horizon, wherever the
 *    map's edge is sea (the land running off the north stays open).
 *  - Small moving ripples in the normals catch the sun; the colour
 *    deepens toward the horizon's haze through the scene fog.
 *
 * Worlds without a water layer (older servers) get no water.
 */

import * as THREE from "three";
import type { WorldMap } from "@mmo-engine/protocol";

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

const RIPPLE_VERTEX_HEAD = /* glsl */ `
  varying vec3 vWaterPos;
`;
const RIPPLE_VERTEX_BODY = /* glsl */ `
  vWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;
const RIPPLE_FRAGMENT_HEAD = /* glsl */ `
  varying vec3 vWaterPos;
  uniform float uTime;
`;
// Tilt the view-space normal by a few crossing wave trains (world metres).
const RIPPLE_FRAGMENT_BODY = /* glsl */ `
  {
    vec2 p = vWaterPos.xz;
    float t = uTime;
    vec2 slope =
        vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 0.9 + t * 1.3) * 0.06
      + vec2(-0.5, 0.85) * cos(dot(p, vec2(-0.5, 0.85)) * 1.7 + t * 1.9) * 0.04
      + vec2(0.95, -0.3) * cos(dot(p, vec2(0.95, -0.3)) * 3.1 + t * 2.6) * 0.025;
    vec3 tilted = normalize(vec3(-slope.x, 1.0, -slope.y));
    normal = normalize((viewMatrix * vec4(tilted, 0.0)).xyz);
  }
`;

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
  private readonly uniforms = { uTime: { value: 0 } };
  private readonly material: THREE.MeshStandardMaterial;
  private mesh: THREE.Mesh | null = null;
  private world: { map: WorldMap; seaLevel: number | null } | null = null;

  constructor() {
    this.group.name = "water";
    this.material = new THREE.MeshStandardMaterial({
      color: 0x1f5a78,
      roughness: 0.08,
      metalness: 0.1,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
    });
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${RIPPLE_VERTEX_HEAD}`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n${RIPPLE_VERTEX_BODY}`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${RIPPLE_FRAGMENT_HEAD}`)
        .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${RIPPLE_FRAGMENT_BODY}`);
    };
    this.material.customProgramCacheKey = () => "mmo-water";
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
    if (!geometry) return;
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

  /** Once per frame: move the ripples. */
  update(timeSeconds: number): void {
    this.uniforms.uTime.value = timeSeconds;
  }

  setWireframe(on: boolean): void {
    this.material.wireframe = on;
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }

  private clear(): void {
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh = null;
  }
}
