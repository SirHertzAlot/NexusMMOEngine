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
export type { HelloAuth, MirrorEvents } from "./client.js";
export { Interpolator } from "./interpolate.js";
export { MirrorState } from "./state.js";
export type { EntityMirror } from "./state.js";
export { BrowserSocket } from "./socket.js";
export type { SocketLike } from "./socket.js";
