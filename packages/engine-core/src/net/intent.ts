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
export {
  decodeIntentMessage,
  encodeIntentMessage,
} from "@mmo-engine/protocol";
export type { DecodedIntentMessage, IntentFields } from "@mmo-engine/protocol";
