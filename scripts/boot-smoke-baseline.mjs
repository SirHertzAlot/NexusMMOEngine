/**
 * The join baseline the boot smokes wait for after `hello` → `welcome`.
 *
 * Two wire shapes carry it, depending on interest management:
 *  - interest off (`MMO_INTEREST=0`): one `Snapshot` (0x03) message.
 *  - interest on (the server default since 73ced85c): a `DeltaSet` (0x25)
 *    with `replace: true`, whose `Full` entries (one per sector) carry the
 *    same state. The real client reads it the same way (packages/mirror
 *    `onDeltaSet`: a replace clears the sector set, Full entries refill it).
 *
 * Both are accepted; whichever arrives first is the baseline. A DeltaSet
 * that is not a replace is a failure, because it is not a baseline.
 */
import { MessageType, decodeSnapshot, decodeDeltaSet, decodeDelta, DeltaSetKind } from "@mmo-engine/protocol";

/**
 * Wait for the join baseline on `client`. Call before `client.hello(...)`
 * so the waiter is registered before the server can answer.
 *
 * Resolves `{ shape, tick, wireBytes, transforms, chunks, detail }`, or
 * rejects with the timeout / bad-shape error for the caller to report.
 */
export async function waitForJoinBaseline(client, timeoutMs) {
  const snapP = client.waitFor(MessageType.Snapshot, 1, timeoutMs).then(([payload]) => ({ kind: "snapshot", payload }));
  const setP = client.waitFor(MessageType.DeltaSet, 1, timeoutMs).then(([payload]) => ({ kind: "deltaset", payload }));
  const first = await Promise.race([snapP, setP]);

  if (first.kind === "snapshot") {
    const snap = decodeSnapshot(first.payload);
    return {
      shape: "snapshot",
      tick: snap.tick,
      wireBytes: first.payload.length,
      transforms: snap.transforms.length,
      chunks: snap.chunks.length,
      detail: "Snapshot message (interest management off)",
    };
  }

  const set = decodeDeltaSet(first.payload);
  if (!set.replace) throw new Error(`first DeltaSet is not a replace (tick ${set.tick}), so it is not a join baseline`);
  let transforms = 0;
  let chunks = 0;
  let fullEntries = 0;
  for (const e of set.entries) {
    if (e.kind !== DeltaSetKind.Full) continue;
    fullEntries++;
    const state = decodeDelta(e.bytes);
    transforms += state.transforms.length;
    chunks += state.chunks.length;
  }
  return {
    shape: "deltaset-replace",
    tick: set.tick,
    wireBytes: first.payload.length,
    transforms,
    chunks,
    detail: `DeltaSet replace (interest management on): ${fullEntries} Full sector entr${fullEntries === 1 ? "y" : "ies"}`,
  };
}
