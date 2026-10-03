/**
 * Friends list (roadmap S2b): who each character follows, by character name.
 * In memory, like blocks: it resets on restart until the world server owns
 * the durable table. A friend can only be added while online (the only time
 * a name resolves without a character-store lookup), but stays listed offline.
 */
import { z } from "zod";

export const FRIEND_LIMIT = 100;

export const FriendSchema = z
  .object({ kind: z.literal("friend"), name: z.string().trim().min(1).max(32), on: z.boolean() })
  .strict();

export type FriendResult = "ok" | "self" | "full" | "exists";

export class FriendBook {
  /** owner key -> (friend key -> display name) */
  private readonly lists = new Map<string, Map<string, string>>();

  add(owner: string, friend: string): FriendResult {
    const o = owner.toLowerCase();
    const f = friend.toLowerCase();
    if (o === f) return "self";
    let list = this.lists.get(o);
    if (!list) this.lists.set(o, (list = new Map()));
    if (list.has(f)) return "exists";
    if (list.size >= FRIEND_LIMIT) return "full";
    list.set(f, friend);
    return "ok";
  }

  remove(owner: string, friend: string): boolean {
    return this.lists.get(owner.toLowerCase())?.delete(friend.toLowerCase()) ?? false;
  }

  /** The owner's friends' display names, in add order. */
  list(owner: string): string[] {
    return [...(this.lists.get(owner.toLowerCase())?.values() ?? [])];
  }

  /** Characters who list `name` as a friend: who to tell when it logs in or out. */
  watchers(name: string): string[] {
    const f = name.toLowerCase();
    const out: string[] = [];
    for (const [owner, list] of this.lists) if (list.has(f)) out.push(owner);
    return out;
  }
}
