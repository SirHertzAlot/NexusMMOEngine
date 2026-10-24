/**
 * Sector topics (Phase 5, Part A: uWS pub/sub fan-out).
 *
 * The gateway used to fan a tick's delta out with one socket.send()
 * per connected client — N syscalls/copies for N clients, all carrying
 * the same bytes. The transport now publishes once per sector topic
 * and the socket library fans the bytes out to the topic's subscribers
 * (natively in uWebSockets.js; emulated by a subscriber loop on the
 * `ws` fallback). The delta itself is still encoded exactly once per
 * tick (Phase 3 SoA encoder) and the bytes are identical — only the
 * fan-out mechanism changes, so clients see zero wire difference.
 *
 * A sector is a square cell of the world grid. A session subscribes
 * to the topic of the sector its avatar stands in; the gateway
 * re-subscribes it when it crosses a sector boundary. Today every
 * sector topic carries the same global delta (no interest filtering:
 * changing which entities a client sees would change client-visible
 * bytes and needs the mirror to handle sector handoffs). Per-sector
 * delta *content* — encoding only the entities in a sector — is the
 * follow-up this topic layer exists to enable.
 *
 * Topic names are `sector:<sx>,<sz>`; the `sector:` prefix keeps them
 * in their own namespace in case the transport ever publishes other
 * topics on the same port.
 */

/** The one topic every session's global delta is published on (IM1). */
export const REGION_TOPIC = "sector:region";

/** World units per sector side. Tunable; 64 keeps a busy area's crowd in a handful of sectors. */
export const SECTOR_SIZE = 64;

/** Grid cell containing world position (x, z). */
export function sectorOf(x: number, z: number): { sx: number; sz: number } {
  return { sx: Math.floor(x / SECTOR_SIZE), sz: Math.floor(z / SECTOR_SIZE) };
}

/** Topic for a grid cell. */
export function sectorTopic(sx: number, sz: number): string {
  return `sector:${sx},${sz}`;
}

/** Topic for the sector containing world position (x, z). */
export function sectorTopicFor(x: number, z: number): string {
  const { sx, sz } = sectorOf(x, z);
  return sectorTopic(sx, sz);
}
