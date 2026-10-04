/**
 * The newest snapshot and delta from the core's mirror stream (E3 pushes
 * `snapshot` every 300 ticks and `tick.delta` every tick). A client the
 * edge starts serving gets `latestSnapshot` first, then live deltas, with
 * no round trip to the core. Payloads stay base64 FlatBuffers, as pushed.
 *
 * Until the edge serves the client protocol, players still connect to the
 * core's gateway; this buffer is what that cutover will read.
 */
import type { ChannelLike } from "@mmo-engine/channel";

export interface MirrorBuffer {
  latestSnapshot: { tick: number; snapshot: string } | null;
  latestDelta: { tick: number; delta: string } | null;
  /** Called for every delta after it is stored. */
  onDelta(cb: (d: { tick: number; delta: string }) => void): void;
}

export function createMirrorBuffer(channel: Pick<ChannelLike, "onPush">): MirrorBuffer {
  const listeners: Array<(d: { tick: number; delta: string }) => void> = [];
  const mb: MirrorBuffer = {
    latestSnapshot: null,
    latestDelta: null,
    onDelta(cb) { listeners.push(cb); },
  };
  channel.onPush("snapshot", (p) => {
    const s = p as { tick: number; snapshot: string };
    mb.latestSnapshot = { tick: s.tick, snapshot: s.snapshot };
  });
  channel.onPush("tick.delta", (p) => {
    const d = p as { tick: number; delta: string };
    mb.latestDelta = { tick: d.tick, delta: d.delta };
    for (const cb of listeners) cb(mb.latestDelta);
  });
  return mb;
}
