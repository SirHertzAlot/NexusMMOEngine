/**
 * Social persistence (roadmap S2c): friends lists and blocks survive a
 * server restart.
 *
 * `SocialStore` is synchronous write-through, like `GuildStore`: the books
 * load everything once at construction and write each change as it
 * happens. `memorySocialStore` is the default (tests, a server without a
 * data dir); `SqliteSocialStore` keeps its own database file
 * (./data/social.db) with the same pragmas as the guild store.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

export interface FriendRow {
  /** Owner's character name, lowercased. */
  owner: string;
  /** Friend's display name as it was added. */
  friend: string;
}

export interface BlockRow {
  /** Blocker's account, lowercased. */
  blocker: string;
  /** Blocked account, lowercased. */
  target: string;
}

export interface SocialStore {
  /** Every friend row, each owner's in add order. */
  loadFriends(): FriendRow[];
  addFriend(owner: string, friend: string): void;
  removeFriend(owner: string, friend: string): void;
  loadBlocks(): BlockRow[];
  addBlock(blocker: string, target: string): void;
  removeBlock(blocker: string, target: string): void;
}

const lc = (s: string): string => s.toLowerCase();

export function memorySocialStore(): SocialStore {
  const friends: FriendRow[] = [];
  const blocks: BlockRow[] = [];
  return {
    loadFriends: () => friends.map((r) => ({ ...r })),
    addFriend: (owner, friend) => {
      if (!friends.some((r) => r.owner === lc(owner) && lc(r.friend) === lc(friend))) {
        friends.push({ owner: lc(owner), friend });
      }
    },
    removeFriend: (owner, friend) => {
      const i = friends.findIndex((r) => r.owner === lc(owner) && lc(r.friend) === lc(friend));
      if (i >= 0) friends.splice(i, 1);
    },
    loadBlocks: () => blocks.map((r) => ({ ...r })),
    addBlock: (blocker, target) => {
      if (!blocks.some((r) => r.blocker === lc(blocker) && r.target === lc(target))) {
        blocks.push({ blocker: lc(blocker), target: lc(target) });
      }
    },
    removeBlock: (blocker, target) => {
      const i = blocks.findIndex((r) => r.blocker === lc(blocker) && r.target === lc(target));
      if (i >= 0) blocks.splice(i, 1);
    },
  };
}

const DDL = `
CREATE TABLE IF NOT EXISTS friends (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  friend_key TEXT NOT NULL,
  friend TEXT NOT NULL,
  UNIQUE (owner, friend_key)
);
CREATE TABLE IF NOT EXISTS blocks (
  blocker TEXT NOT NULL,
  target TEXT NOT NULL,
  PRIMARY KEY (blocker, target)
);
`;

export class SqliteSocialStore implements SocialStore {
  private readonly db: Database.Database;
  private readonly stmts: {
    addFriend: Database.Statement;
    removeFriend: Database.Statement;
    addBlock: Database.Statement;
    removeBlock: Database.Statement;
  };

  /** `target` is a file path, or an open handle (shared with another store). */
  constructor(target: string | Database.Database) {
    if (typeof target === "string") {
      const file = path.resolve(target);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.db = new Database(file);
      this.db.pragma("journal_mode = WAL");
    } else {
      this.db = target;
    }
    this.db.exec(DDL);
    this.stmts = {
      addFriend: this.db.prepare("INSERT OR IGNORE INTO friends (owner, friend_key, friend) VALUES (?, ?, ?)"),
      removeFriend: this.db.prepare("DELETE FROM friends WHERE owner = ? AND friend_key = ?"),
      addBlock: this.db.prepare("INSERT OR IGNORE INTO blocks (blocker, target) VALUES (?, ?)"),
      removeBlock: this.db.prepare("DELETE FROM blocks WHERE blocker = ? AND target = ?"),
    };
  }

  loadFriends(): FriendRow[] {
    return this.db.prepare("SELECT owner, friend FROM friends ORDER BY seq").all() as FriendRow[];
  }

  addFriend(owner: string, friend: string): void {
    this.stmts.addFriend.run(lc(owner), lc(friend), friend);
  }

  removeFriend(owner: string, friend: string): void {
    this.stmts.removeFriend.run(lc(owner), lc(friend));
  }

  loadBlocks(): BlockRow[] {
    return this.db.prepare("SELECT blocker, target FROM blocks ORDER BY rowid").all() as BlockRow[];
  }

  addBlock(blocker: string, target: string): void {
    this.stmts.addBlock.run(lc(blocker), lc(target));
  }

  removeBlock(blocker: string, target: string): void {
    this.stmts.removeBlock.run(lc(blocker), lc(target));
  }

  close(): void {
    this.db.close();
  }
}
