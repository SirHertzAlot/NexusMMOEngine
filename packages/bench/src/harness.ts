/**
 * Shared setup for the slice-1.5 validation benchmark (Phase 1 plan §6).
 *
 * Harness A: bitECS world (Transform + Velocity from @mmo-engine/engine-core)
 *   + ONE N-API call per tick: integrate(px,py,pz,vx,vy,vz,count,dt) over the
 *   JS-owned SoA stores (zero-copy — N-API hands C++ a raw pointer).
 * Harness B: pure C++ world behind ONE N-API call per tick: stepWorld(h, dt).
 *
 * Both run the same integrate_kernel in C++, so measured differences are
 * world-location / boundary cost, not implementation differences.
 */

import { createRequire } from "node:module";
import {
  addComponent,
  addEntity,
  createWorld,
  type IWorld,
} from "bitecs";
import * as bitECS from "bitecs";

/** bitECS 0.3.40 exposes resetGlobals at runtime but not in its types. */
const resetBitECSGlobals = (): void =>
  (bitECS as unknown as { resetGlobals(): void }).resetGlobals();
import { Transform, Velocity } from "@mmo-engine/engine-core";
import type * as AddonApi from "@mmo-engine/addon-integrate";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const addon = require("@mmo-engine/addon-integrate") as typeof AddonApi;

export const DT = 1 / 30;

/** Deterministic PRNG (mulberry32) — identical initial data every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SoA {
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
}

/** Harness A state: a bitECS world whose component stores ARE the SoA. */
export interface HarnessA {
  world: IWorld;
  arrays: SoA;
  tick: () => void;
}

/** Build harness A: n entities, deterministic initial data, one tick fn. */
export function setupHarnessA(n: number, seed: number): HarnessA {
  // bitECS keeps a process-global entity cursor shared by all worlds, so a
  // fresh world per harness needs the cursor reset (same pattern as
  // SimWorld.resetEntityCursorForTesting in engine-core). Worlds are built
  // sequentially and never two are live at once.
  resetBitECSGlobals();
  const world = createWorld(n);
  const rand = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const eid = addEntity(world);
    addComponent(world, Transform, eid);
    addComponent(world, Velocity, eid);
    // Positions in [-500, 500], velocities in [-20, 20].
    Transform.px[eid] = rand() * 1000 - 500;
    Transform.py[eid] = rand() * 1000 - 500;
    Transform.pz[eid] = rand() * 1000 - 500;
    Velocity.lx[eid] = rand() * 40 - 20;
    Velocity.ly[eid] = rand() * 40 - 20;
    Velocity.lz[eid] = rand() * 40 - 20;
  }
  // bitECS component stores are process-global singletons sized to the
  // bitECS default (100k), not to the world size — hand out subarray views
  // of exactly [0, n) so both harnesses see identical, exactly-n data.
  // Subarrays share the buffer, so N-API access stays zero-copy
  // (napi_get_typedarray_info accounts for the view's byte offset).
  const sub = (a: Float32Array): Float32Array => a.subarray(0, n);
  const arrays: SoA = {
    px: sub(Transform.px as Float32Array),
    py: sub(Transform.py as Float32Array),
    pz: sub(Transform.pz as Float32Array),
    vx: sub(Velocity.lx as Float32Array),
    vy: sub(Velocity.ly as Float32Array),
    vz: sub(Velocity.lz as Float32Array),
  };
  const tick = () =>
    addon.integrate(
      arrays.px,
      arrays.py,
      arrays.pz,
      arrays.vx,
      arrays.vy,
      arrays.vz,
      n,
      DT,
    );
  return { world, arrays, tick };
}

/** Harness B state: opaque C++ world handle + one tick fn. */
export interface HarnessB {
  handle: AddonApi.WorldHandle;
  tick: () => void;
  readPositions: () => SoA;
}

/** Build harness B from the SAME initial data as an existing harness A. */
export function setupHarnessB(from: SoA): HarnessB {
  const handle = addon.createWorld(
    from.px,
    from.py,
    from.pz,
    from.vx,
    from.vy,
    from.vz,
  );
  const n = from.px.length;
  const tick = () => addon.stepWorld(handle, DT);
  const readPositions = (): SoA => {
    const ox = new Float32Array(n);
    const oy = new Float32Array(n);
    const oz = new Float32Array(n);
    addon.copyPositions(handle, ox, oy, oz);
    // Velocities never change under pure integration; copy for shape parity.
    return {
      px: ox,
      py: oy,
      pz: oz,
      vx: from.vx.slice(),
      vy: from.vy.slice(),
      vz: from.vz.slice(),
    };
  };
  return { handle, tick, readPositions };
}

/**
 * Exact f32 equality between harness A and B positions. Both harnesses run
 * the identical C++ kernel over identical inputs in identical order, so any
 * bit difference is a real bug, not float noise. Returns max abs diff.
 */
export function maxPositionDiff(a: SoA, b: SoA): number {
  const n = a.px.length;
  let max = 0;
  for (let i = 0; i < n; i++) {
    max = Math.max(
      max,
      Math.abs(a.px[i] - b.px[i]),
      Math.abs(a.py[i] - b.py[i]),
      Math.abs(a.pz[i] - b.pz[i]),
    );
  }
  return max;
}
