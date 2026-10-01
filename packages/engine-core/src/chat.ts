/**
 * Region chat (roadmap S1): shape validation, per-channel range and
 * rate limits, and the text-filter hook. The gateway owns fan-out;
 * this module owns the rules, so tuning them never touches sockets.
 */

import { z } from "zod";
import type { ChatChannel } from "@mmo-engine/protocol";

/** Say and emote reach avatars within this many metres; yell is region-wide. */
export const SAY_RANGE_M = 30;

/** Per-channel cooldowns (ms) between two lines from one session. */
export const CHAT_COOLDOWN_MS: Record<ChatChannel, number> = {
  say: 2000,
  yell: 10000,
  emote: 2000,
};

/** Chat text: trimmed server-side, 1–500 chars after trimming. */
export const CHAT_TEXT_MAX = 500;

export const ChatSchema = z
  .object({
    kind: z.literal("chat"),
    channel: z.enum(["say", "yell", "emote"]),
    text: z.string().trim().min(1).max(CHAT_TEXT_MAX),
  })
  .strict();

export type ChatPayload = z.infer<typeof ChatSchema>;

/**
 * Text filter hook (roadmap S1): return false to reject a line.
 * Default allows everything that passes shape limits; a profanity or
 * abuse service plugs in here without gateway changes.
 */
export type TextFilter = (text: string) => boolean;

export function allowAllText(_text: string): boolean {
  return true;
}
