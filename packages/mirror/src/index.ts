/**
 * @mmo-engine/mirror — the shared mirror protocol driver.
 *
 * The browser (and the editor) never simulate: they connect, say
 * hello, and fold authoritative snapshots/deltas into a local
 * MirrorState while sending player intents upstream
 * (docs/MESSAGE-CATALOG.md). Editor-only read-only debug queries
 * (0x0a) ride the same connection.
 */
export { MirrorClient } from "./client.js";
export type { HelloAuth, JoinAuth, JoinReply, MirrorEvents } from "./client.js";
export { Interpolator, type PushListener } from "./interpolate.js";
export { MirrorState } from "./state.js";
export type { DeltaSetResult, EntityMirror } from "./state.js";
export { LaggySocket, latencyMs } from "./laggy-socket.js";
export { BrowserSocket } from "./socket.js";
export type { SocketLike } from "./socket.js";
