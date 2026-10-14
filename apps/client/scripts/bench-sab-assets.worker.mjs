/**
 * worker_threads entry for bench-sab-assets.mjs. Runs the real
 * assetDecodeHandler (the same code the browser worker runs) in a
 * separate thread, decoding into the SAB the main thread provided.
 */
import { parentPort } from "node:worker_threads";
import { assetDecodeHandler } from "../dist/src/workers/handlers/asset-decode.js";

parentPort.on("message", async (msg) => {
  try {
    const result = await assetDecodeHandler.handle(msg);
    parentPort.postMessage({ ok: true, result });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e?.message ?? e) });
  }
});
