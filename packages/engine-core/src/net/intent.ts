/**
 * IntentMessage codec (slice 1.3, docs/MESSAGE-CATALOG.md §0x05).
 *
 * The encode/decode implementation lives in @mmo-engine/protocol's codec
 * (packages/protocol/src/codec.ts) so the mirror client shares it without
 * depending on the sim. Re-exported here so existing engine-core imports
 * keep working (DRY: one definition).
 *
 * The server's QueuedIntent has exactly the IntentFields shape; the
 * gateway adapts at its boundary.
 */
import type { IntentFields } from "@mmo-engine/protocol";

export {
  decodeIntentMessage,
  encodeIntentMessage,
} from "@mmo-engine/protocol";
export type { DecodedIntentMessage, IntentFields } from "@mmo-engine/protocol";

/**
 * Validate a decoded intent at the trust boundary. Every number must be
 * finite (a NaN would reach positions and the native terrain lookups),
 * and the move is capped: the horizontal (mx, mz) at length 1 and the
 * vertical (my: swim up/down, climb/descend in flight) at ±1, separately,
 * so rising while moving doesn't slow you down. The client picks a
 * direction, the server owns the speed. Returns null for an intent that
 * can't be used.
 */
export function sanitizeIntent(intent: IntentFields): IntentFields | null {
  const { mx, my, mz, lookYaw, lookPitch } = intent;
  if (![mx, my, mz, lookYaw, lookPitch].every(Number.isFinite)) return null;
  const len = Math.hypot(mx, mz);
  // Tolerance: a client's unit diagonal can land a rounding error over 1.
  if (len <= 1 + 1e-6 && Math.abs(my) <= 1) return intent;
  const k = len > 1 ? 1 / len : 1;
  return { ...intent, mx: mx * k, my: Math.max(-1, Math.min(1, my)), mz: mz * k };
}
