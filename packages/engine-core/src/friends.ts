/**
 * Friends list (roadmap S2b): who each character follows, by character name.
 * Writes through to a `SocialStore` (SQLite in the server, S2c), so lists
 * survive a restart. A friend can only be added while online (the only time
 * a name resolves without a character-store lookup), but stays listed offline.
 */
import { z } from "zod";
import { memorySocialStore, type SocialStore } from "./social-store.js";

export const FRIEND_LIMIT = 100;

export const FriendSchema = z
  .object({ kind: z.literal("friend"), name: z.string().trim().min(1).max(32), on: z.boolean() })
  .strict();

export type FriendResult = "ok" | "self" | "full" | "exists";

/** Synchronous write-through storage; `memoryFriendStore` is the default. */
export interface FriendStore {
  /** Every owner's friends (display names), in add order. */
  loadAll(): Array<{ owner: string; friends: string[] }>;
  add(owner: string, friend: string): void;
  remove(owner: string, friend: string): void;
}

export function memoryFriendStore(): FriendStore {
  const all = new Map<string, Map<string, string>>();
  return {
    loadAll: () => [...all].map(([owner, m]) => ({ owner, friends: [...m.values()] })),
    add: (owner, friend) => {
      const key = owner.toLowerCase();
      let m = all.get(key);
      if (!m) all.set(key, (m = new Map()));
      m.set(friend.toLowerCase(), friend);
    },
    remove: (owner, friend) => void all.get(owner.toLowerCase())?.delete(friend.toLowerCase()),
  };
}

type FriendPersistence = Pick<SocialStore, "loadFriends" | "addFriend" | "removeFriend">;

function friendPersistence(store: SocialStore | FriendStore): FriendPersistence {
  if ("loadFriends" in store) return store;
  return {
    loadFriends: () => store.loadAll().flatMap(({ owner, friends }) =>
      friends.map((friend) => ({ owner, friend })),
    ),
    addFriend: (owner, friend) => store.add(owner, friend),
    removeFriend: (owner, friend) => store.remove(owner, friend),
  };
}

export class FriendBook {
  /** owner key -> (friend key -> display name) */
  private readonly lists = new Map<string, Map<string, string>>();
  private readonly store: FriendPersistence;

  constructor(store: SocialStore | FriendStore = memorySocialStore()) {
    this.store = friendPersistence(store);
    this.reload();
  }

  /** Read every list again from the store (another region changed some, PL3c). */
  reload(): void {
    this.lists.clear();
    for (const r of this.store.loadFriends()) {
      let list = this.lists.get(r.owner);
      if (!list) this.lists.set(r.owner, (list = new Map()));
      list.set(r.friend.toLowerCase(), r.friend);
    }
  }

  add(owner: string, friend: string): FriendResult {
    const o = owner.toLowerCase();
    const f = friend.toLowerCase();
    if (o === f) return "self";
    let list = this.lists.get(o);
    if (!list) this.lists.set(o, (list = new Map()));
    if (list.has(f)) return "exists";
    if (list.size >= FRIEND_LIMIT) return "full";
    list.set(f, friend);
    this.store.addFriend(o, friend);
    return "ok";
  }

  remove(owner: string, friend: string): boolean {
    const gone = this.lists.get(owner.toLowerCase())?.delete(friend.toLowerCase()) ?? false;
    if (gone) this.store.removeFriend(owner, friend);
    return gone;
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
