/**
 * Worker entry for the terrain mask bake: bakes one slab of chunk rows and
 * posts the channel bytes back. The source arrays come in via workerData.
 */
import { parentPort, workerData } from "node:worker_threads";
import { bakeMaskSlab, type MaskSource } from "./mask-bake.js";
import type { TerrainMaskSpec } from "@mmo-engine/art/browser";

interface MaskWorkerData {
  src: MaskSource;
  maskSpec: TerrainMaskSpec;
  bounds: { minChunk: number; maxChunk: number };
  czFrom: number;
  czTo: number;
}

const d = workerData as MaskWorkerData;
const slab = bakeMaskSlab(d.src, d.maskSpec, d.bounds, d.czFrom, d.czTo);
parentPort?.postMessage(slab);
