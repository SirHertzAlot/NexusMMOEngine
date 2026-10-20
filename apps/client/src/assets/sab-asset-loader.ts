/**
 * Main-thread side of the client SAB asset pipeline (SAB Phase 6).
 *
 * `SabAssetLoader.decodeGlbBytes()`:
 * 1. SAB path (when the page is cross-origin isolated and a worker pool is
 *    wired): allocate a SAB sized exactly to the decoded payload, hand the
 *    worker a *copy* of the compressed GLB bytes + the SAB, and build
 *    THREE.BufferGeometry attributes as views over the SAB — the decoded
 *    vertex data is never copied on the main thread and the decode never
 *    runs there. On SAB overflow the worker reports the bytes it needed
 *    and the loader retries once with a bigger arena.
 * 2. Fallback (no SAB / no workers / worker failure): decode the same bytes
 *    on the main thread via the shared `decodeGlb()` core. Same geometry
 *    out, just decoded locally. The fallback is the correctness floor —
 *    a load must never fail because the fast path is unavailable.
 *
 * The compressed GLB bytes are copied per worker attempt on purpose: the
 * worker runtime transfers the payload's ArrayBuffer (zero-copy handoff),
 * which detaches the sender's copy — sending the caller's buffer would
 * destroy the bytes needed for a retry or the fallback.
 */

import * as THREE from "three";
import { SabArena, SabArenaState, SAB_ARENA_HEADER_BYTES } from "./sab-arena.js";
import { probeSabSupport, type SabSupport } from "./sab-support.js";
import {
  COMPONENTS,
  decodeGlb,
  estimateSabPayloadBytes,
  type DecodedGlb,
  type SabDecodeResult,
} from "./glb-meshopt.js";
import type { WorkerRequester } from "../workers/pool.js";

export type DecodeVia = "sab-worker" | "main-thread";

export interface DecodedGeometries {
  geometries: THREE.BufferGeometry[];
  via: DecodeVia;
  /** SAB payload bytes when via === 'sab-worker', else null. */
  sabBytes: number | null;
}

export interface SabAssetLoaderOptions {
  /** Worker pool (e.g. the world's WorkerPool). Absent -> main-thread fallback. */
  workers?: WorkerRequester;
  /** Capability probe result; defaults to probing this environment. */
  support?: SabSupport;
  /** Largest SAB the loader will allocate (default 256 MiB). Larger assets decode on the main thread. */
  maxSabBytes?: number;
  /** Fetch implementation (injectable for tests). */
  fetchImpl?: typeof fetch;
}

function typedArrayFromBytes(
  componentType: number,
  bytes: Uint8Array,
  count: number,
  itemSize: number,
): THREE.BufferAttribute {
  const Ctor = (COMPONENTS as Record<number, readonly [any, number]>)[componentType]?.[0];
  if (!Ctor) throw new Error(`unsupported componentType ${componentType}`);
  const array = new Ctor(bytes.buffer, bytes.byteOffset, count * itemSize);
  return new THREE.BufferAttribute(array, itemSize);
}

/**
 * glTF attribute semantic -> three.js attribute name. The decode layer
 * stays spec-faithful (POSITION, TEXCOORD_0, ...); only the geometry
 * builder translates, so `geometry.getAttribute("position")` works.
 */
export function threeAttributeName(gltfName: string): string {
  if (gltfName === "POSITION") return "position";
  if (gltfName === "NORMAL") return "normal";
  if (gltfName === "TANGENT") return "tangent";
  if (gltfName.startsWith("TEXCOORD_")) {
    const n = Number(gltfName.slice("TEXCOORD_".length));
    return n === 0 ? "uv" : `uv${n + 1}`;
  }
  if (gltfName.startsWith("COLOR_")) {
    const n = Number(gltfName.slice("COLOR_".length));
    return n === 0 ? "color" : `color${n + 1}`;
  }
  if (gltfName.startsWith("JOINTS_")) return "skinIndex";
  if (gltfName.startsWith("WEIGHTS_")) return "skinWeight";
  return gltfName.toLowerCase();
}

function buildGeometry(
  attributes: Array<{ name: string; componentType: number; itemSize: number; count: number; normalized: boolean; bytes: Uint8Array }>,
  index: { componentType: number; count: number; bytes: Uint8Array } | null,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  for (const attr of attributes) {
    const attribute = typedArrayFromBytes(attr.componentType, attr.bytes, attr.count, attr.itemSize);
    attribute.normalized = attr.normalized;
    geometry.setAttribute(threeAttributeName(attr.name), attribute);
  }
  if (index) {
    geometry.setIndex(typedArrayFromBytes(index.componentType, index.bytes, index.count, 1));
  }
  return geometry;
}

/** BufferGeometry[] from main-thread-decoded bytes (fallback path). */
export function decodedGeometries(decoded: DecodedGlb): THREE.BufferGeometry[] {
  return decoded.primitives.map((prim) => buildGeometry(prim.attributes, prim.index));
}

/**
 * BufferGeometry[] from a worker decode: every attribute is a typed-array
 * view over the SAME SharedArrayBuffer — zero copy of the vertex data.
 * The geometries keep the SAB alive through their attribute arrays.
 */
export function sabGeometries(sab: SharedArrayBuffer, result: SabDecodeResult): THREE.BufferGeometry[] {
  return result.primitives.map((prim) =>
    buildGeometry(
      prim.attributes.map((a) => ({
        ...a,
        bytes: new Uint8Array(sab, a.byteOffset, a.count * a.itemSize * (COMPONENTS as Record<number, readonly [unknown, number]>)[a.componentType][1]),
      })),
      prim.index
        ? {
            componentType: prim.index.componentType,
            count: prim.index.count,
            bytes: new Uint8Array(sab, prim.index.byteOffset, prim.index.count * (COMPONENTS as Record<number, readonly [unknown, number]>)[prim.index.componentType][1]),
          }
        : null,
    ),
  );
}

export class SabAssetLoader {
  private readonly workers?: WorkerRequester;
  private readonly support: SabSupport;
  private readonly maxSabBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SabAssetLoaderOptions = {}) {
    this.workers = opts.workers;
    this.support = opts.support ?? probeSabSupport();
    this.maxSabBytes = opts.maxSabBytes ?? 256 * 1024 * 1024;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Decode GLB bytes into BufferGeometry[] via the SAB worker path or the main-thread fallback. */
  async decodeGlbBytes(glbBytes: Uint8Array): Promise<DecodedGeometries> {
    if (this.support.usable && this.workers) {
      const sab = await this.trySabDecode(glbBytes);
      if (sab) return sab;
    }
    const decoded = await decodeGlb(glbBytes);
    return { geometries: decodedGeometries(decoded), via: "main-thread", sabBytes: null };
  }

  /** Fetch a GLB URL (main thread fetch — auth/caching behavior unchanged) and decode it. */
  async fetchAndDecodeGlb(url: string): Promise<DecodedGeometries> {
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
    return this.decodeGlbBytes(new Uint8Array(await res.arrayBuffer()));
  }

  /**
   * SAB worker path with one overflow retry. Returns null when the SAB path
   * is unavailable or fails — the caller falls back to main-thread decode.
   * Never throws for SAB/worker reasons; malformed GLBs still throw from
   * the fallback decode.
   */
  private async trySabDecode(glbBytes: Uint8Array): Promise<DecodedGeometries | null> {
    try {
      const estimate = estimateSabPayloadBytes(glbBytes);
      if (estimate + SAB_ARENA_HEADER_BYTES > this.maxSabBytes) return null;
      let needed = estimate;
      for (let attempt = 0; attempt < 2; attempt++) {
        const arena = SabArena.create(needed + SAB_ARENA_HEADER_BYTES + 1024);
        // Copy: the runtime transfers this buffer to the worker (detaches it).
        const glbCopy = glbBytes.slice().buffer as ArrayBuffer;
        const result = await this.workers!.request("assetDecode", { glb: glbCopy, sab: arena.sab });
        if ("overflow" in result) {
          needed = result.neededBytes;
          if (needed + SAB_ARENA_HEADER_BYTES > this.maxSabBytes) return null;
          continue;
        }
        if (arena.state !== SabArenaState.Ready) return null;
        const geometries = sabGeometries(arena.sab, result);
        arena.markConsumed();
        return { geometries, via: "sab-worker", sabBytes: arena.usedBytes };
      }
      return null;
    } catch {
      // Worker down, decode error in worker, arena timeout — the fallback
      // re-decodes on the main thread and surfaces the real error if any.
      return null;
    }
  }
}
