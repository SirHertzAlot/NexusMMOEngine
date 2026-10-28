/**
 * Probe worker: proves a real Phase 1 bitECS component store is shared
 * memory with the main thread.
 *
 * The main thread passes one component field's SharedArrayBuffer plus a
 * byte offset and a value. The worker reads the current value at that
 * offset, writes the new value through a fresh typed-array view over the
 * SAME buffer, and posts both back. If the main thread then observes the
 * new value through its own bitECS view, the component store is genuinely
 * shared — not copied, not serialized.
 *
 * Protocol: workerData { sab, byteOffset, kind, value } ->
 * one { readBefore, readAfter } message, then idle until terminated.
 */

import { parentPort, workerData } from "node:worker_threads";

type ProbeKind = "f32" | "f64" | "i32" | "u32";

interface ProbeData {
  sab: SharedArrayBuffer;
  byteOffset: number;
  kind: ProbeKind;
  value: number;
}

if (parentPort) {
  const { sab, byteOffset, kind, value } = workerData as ProbeData;
  const view =
    kind === "f32"
      ? new Float32Array(sab, byteOffset, 1)
      : kind === "f64"
        ? new Float64Array(sab, byteOffset, 1)
        : kind === "i32"
          ? new Int32Array(sab, byteOffset, 1)
          : new Uint32Array(sab, byteOffset, 1);
  const readBefore = view[0];
  view[0] = value;
  const readAfter = view[0];
  parentPort.postMessage({ readBefore, readAfter });
}
