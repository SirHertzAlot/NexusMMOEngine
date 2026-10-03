/**
 * Region chat (roadmap S1): shape validation, per-channel range and
 * rate limits, and the text-filter hook. The gateway owns fan-out;
 * this module owns the rules, so tuning them never touches sockets.
 */

import { z } from "zod";
import type { ChatChannel } from "@mmo-engine/protocol";
import { memorySocialStore, type SocialStore } from "./social-store.js";

/** Say and emote reach avatars within this many metres; yell is region-wide. */
export const SAY_RANGE_M = 30;

/** Per-channel cooldowns (ms) between two lines from one session. */
export const CHAT_COOLDOWN_MS: Record<ChatChannel, number> = {
  say: 2000,
  yell: 10000,
  emote: 2000,
  whisper: 1000,
  party: 500,
  guild: 500,
};

/** Chat text: trimmed server-side, 1–500 chars after trimming. */
export const CHAT_TEXT_MAX = 500;

export const ChatSchema = z
  .object({
    kind: z.literal("chat"),
    channel: z.enum(["say", "yell", "emote", "whisper", "party", "guild"]),
    text: z.string().trim().min(1).max(CHAT_TEXT_MAX),
    to: z.string().trim().min(1).max(32).optional(),
  })
  .strict()
  .refine((m) => (m.channel === "whisper") === (m.to !== undefined), { message: "whisper needs `to`; other channels must not have it" });

export const BlockSchema = z
  .object({ kind: z.literal("block"), name: z.string().trim().min(1).max(32), on: z.boolean() })
  .strict();

/** Blocks per account (spec 5.3). */
export const BLOCK_LIMIT = 200;

/** Reply to a whisper to anyone offline, unknown or blocking: never says which. */
export const NOT_ONLINE = "not online";

/**
 * Who blocks whom, by account name (S2).
 */
export class BlockList {
  private readonly blocks = new Map<string, Set<string>>();

  /** Writes through to `store` (SQLite in the server, S2c), so blocks survive a restart. */
  constructor(private readonly store: SocialStore = memorySocialStore()) {
    for (const r of store.loadBlocks()) {
      let set = this.blocks.get(r.blocker);
      if (!set) this.blocks.set(r.blocker, (set = new Set()));
      set.add(r.target);
    }
  }

  isBlocked(blocker: string, sender: string): boolean {
    return this.blocks.get(blocker.toLowerCase())?.has(sender.toLowerCase()) ?? false;
  }

  /** False when blocking yourself or over the limit. */
  add(blocker: string, target: string): boolean {
    const b = blocker.toLowerCase();
    const t = target.toLowerCase();
    if (b === t) return false;
    let set = this.blocks.get(b);
    if (!set) this.blocks.set(b, (set = new Set()));
    if (set.has(t)) return true;
    if (set.size >= BLOCK_LIMIT) return false;
    set.add(t);
    this.store.addBlock(b, t);
    return true;
  }

  remove(blocker: string, target: string): void {
    if (this.blocks.get(blocker.toLowerCase())?.delete(target.toLowerCase())) this.store.removeBlock(blocker, target);
  }
}

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
