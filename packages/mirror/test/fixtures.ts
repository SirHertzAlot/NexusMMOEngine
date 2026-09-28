/**
 * Shared fixtures for the mirror-client unit tests: plain-data
 * CollectedState rows encoded through the real @mmo-engine/protocol
 * codec, so the tests exercise the actual wire format (no mocks of
 * the codec itself).
 */

import type {
  CollectedState,
  TransformRow,
} from "@mmo-engine/protocol";

export function transformRow(
  wireId: bigint,
  px: number,
  py = 0,
  pz = 0,
): TransformRow {
  return {
    wireId,
    px, py, pz,
    qx: 0, qy: 0, qz: 0, qw: 1,
    sx: 1, sy: 1, sz: 1,
  };
}

export function emptyState(tick: number, baseTick = 0): CollectedState {
  return {
    tick,
    baseTick,
    transforms: [],
    velocities: [],
    intents: [],
    chunks: [],
    healths: [],
    bodies: [],
    assets: [],
    spawned: [],
    despawned: [],
  };
}
