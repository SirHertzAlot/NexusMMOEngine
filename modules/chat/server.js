/**
 * Chat module server entry (complete-modularity slice 1).
 *
 * Re-exports the chat rule bundle the gateway consumes via injection
 * (GatewayOptions.chatRules). The gateway no longer imports the chat
 * rules directly — server.ts loads this entry and injects its exports.
 * A third-party chat module replaces this file with its own rules.
 */
export {
  allowAllText,
  BlockList,
  BlockSchema,
  CHAT_COOLDOWN_MS,
  ChatSchema,
  NOT_ONLINE,
  SAY_RANGE_M,
} from "../../packages/engine-core/dist/src/chat.js";
