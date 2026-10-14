/**
 * Worker handler: decode a GLB (meshopt-compressed or plain) into a
 * SharedArrayBuffer arena (SAB Phase 6). The worker owns the decode —
 * meshopt WASM + GLB parse + accessor gather — and the main thread reads
 * the decoded bytes out of the SAB without copying them.
 *
 * On SAB overflow the handler reports the bytes the job needed (rather
 * than throwing) so the main thread can retry once with a bigger arena.
 */
import { SabArena } from "../../assets/sab-arena.js";
import { decodeGlbIntoSab, type SabDecodeResult } from "../../assets/glb-meshopt.js";
import type { WorkerTaskHandler } from "../types.js";
import { SabOverflowError } from "../../assets/sab-arena.js";

export interface AssetDecodeOverflow {
  overflow: true;
  neededBytes: number;
}

export type AssetDecodeHandlerResult = SabDecodeResult | AssetDecodeOverflow;

export const assetDecodeHandler: WorkerTaskHandler<"assetDecode"> = {
  type: "assetDecode",
  async handle({ glb, sab }) {
    const arena = SabArena.wrap(sab);
    arena.beginWrite();
    try {
      const result = await decodeGlbIntoSab(new Uint8Array(glb), arena);
      arena.publish();
      return result;
    } catch (err) {
      if (err instanceof SabOverflowError) {
        arena.markError(err.neededBytes);
        return { overflow: true as const, neededBytes: err.neededBytes };
      }
      throw err;
    }
  },
};
