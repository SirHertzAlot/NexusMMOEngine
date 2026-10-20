/**
 * ItemLedger — every change to an item (roadmap P2a), appended to world.db
 * beside the snapshots, so items and bags survive restarts.
 *
 * The ledger is an event log, never updated in place: each row says what an
 * item became (created, on the ground at x/z, in a bag slot, in a hand, or
 * destroyed) with the tick it happened (valid time) and the wall-clock
 * moment it was written (transaction time). A destroy row is the tombstone.
 * Every row carries the item's whole state, so the latest row of an item is
 * enough to restore it and older rows are its history.
 *
 * Recording is allocation-free: events land in preallocated typed-array
 * columns (grown, rarely, when a burst fills them) and `flush()` writes the
 * lot in one transaction, off the tick, on the server's save timer.
 *
 * Authority: after a restart the ledger is the truth for items. Loaded
 * ground items get fresh despawn timers (see ItemService.restore).
 */

import Database from "better-sqlite3";

const DDL = `
CREATE TABLE IF NOT EXISTS item_events (
  seq INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  committed_at INTEGER NOT NULL,
  kind INTEGER NOT NULL,
  def INTEGER NOT NULL,
  owner REAL NOT NULL,
  slot INTEGER NOT NULL,
  durability REAL NOT NULL,
  x REAL NOT NULL,
  z REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS item_events_item ON item_events (item_id, seq);
-- EA17: materialized latest-state cache. Updated on every flush; load()
-- reads this table instead of the O(n^2) MAX(seq) subquery over item_events.
CREATE TABLE IF NOT EXISTS item_latest (
  item_id INTEGER PRIMARY KEY,
  tick INTEGER NOT NULL,
  kind INTEGER NOT NULL,
  def INTEGER NOT NULL,
  owner REAL NOT NULL,
  slot INTEGER NOT NULL,
  durability REAL NOT NULL,
  x REAL NOT NULL,
  z REAL NOT NULL
);
`;

/** What an event says the item became. */
export const LedgerKind = {
  Create: 0,
  Ground: 1,
  Bag: 2,
  Hold: 3,
  /** Worn in an armour slot (slot: the ARMOUR_SLOTS index). */
  Wear: 5,
  /** Tombstone: the item no longer exists. */
  Destroy: 4,
} as const;
export type LedgerKindCode = (typeof LedgerKind)[keyof typeof LedgerKind];

/** An item as of its latest event. */
export interface ItemRow {
  id: number;
  kind: LedgerKindCode;
  def: number;
  /** Character holding it (bag, hand), or the ground drop's owner; 0: nobody. */
  owner: number;
  /** Bag slot or hand index; 0 otherwise. */
  slot: number;
  durability: number;
  x: number;
  z: number;
}

const INITIAL_EVENTS = 256;

export class ItemLedger {
  /** Tick stamped on recorded events; the item service sets it each tick. */
  tick = 0;

  private readonly db: Database.Database;
  /** False when borrowing another store's connection (don't close it). */
  private readonly ownsDb: boolean;
  private readonly insertStmt: Database.Statement;
  private readonly liveStmt: Database.Statement;
  private readonly maxIdStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly flushTx: (n: number, at: number) => void;
  /** EA17: upsert into item_latest (INSERT OR REPLACE by item_id). */
  private readonly latestUpsertStmt: Database.Statement;
  /** EA17: remove a tombstoned item from item_latest. */
  private readonly latestDeleteStmt: Database.Statement;

  private capacity = INITIAL_EVENTS;
  private n = 0;
  private kinds = new Uint8Array(INITIAL_EVENTS);
  private ids = new Uint32Array(INITIAL_EVENTS);
  private ticks = new Uint32Array(INITIAL_EVENTS);
  private defs = new Uint32Array(INITIAL_EVENTS);
  private owners = new Float64Array(INITIAL_EVENTS);
  private slots = new Int16Array(INITIAL_EVENTS);
  private durs = new Float32Array(INITIAL_EVENTS);
  private xs = new Float32Array(INITIAL_EVENTS);
  private zs = new Float32Array(INITIAL_EVENTS);

  /**
   * Open world.db by path, or borrow an open connection. `autoCheckpoint:
   * false` leaves WAL checkpoints to another connection (the server's
   * SnapshotStore runs them after every save).
   */
  constructor(db: string | Database.Database, opts: { autoCheckpoint?: boolean } = {}) {
    this.ownsDb = typeof db === "string";
    if (typeof db === "string") {
      this.db = new Database(db);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      if (opts.autoCheckpoint === false) this.db.pragma("wal_autocheckpoint = 0");
    } else {
      this.db = db;
    }
    this.db.exec(DDL);
    this.insertStmt = this.db.prepare(
      "INSERT INTO item_events (item_id, tick, committed_at, kind, def, owner, slot, durability, x, z) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.liveStmt = this.db.prepare(
      `SELECT item_id AS id, kind, def, owner, slot, durability, x, z FROM item_latest ORDER BY item_id`,
    );
    this.maxIdStmt = this.db.prepare("SELECT COALESCE(MAX(item_id), 0) AS id FROM item_events");
    this.countStmt = this.db.prepare("SELECT COUNT(*) AS n FROM item_events");
    // EA17: keep item_latest in sync on every flush.
    this.latestUpsertStmt = this.db.prepare(
      `INSERT INTO item_latest (item_id, tick, kind, def, owner, slot, durability, x, z)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
         tick = excluded.tick, kind = excluded.kind, def = excluded.def,
         owner = excluded.owner, slot = excluded.slot, durability = excluded.durability,
         x = excluded.x, z = excluded.z`,
    );
    this.latestDeleteStmt = this.db.prepare("DELETE FROM item_latest WHERE item_id = ?");
    // EA17: backfill item_latest from item_events on open (existing DBs).
    this.db.exec(`
      INSERT OR IGNORE INTO item_latest (item_id, tick, kind, def, owner, slot, durability, x, z)
      SELECT e.item_id, e.tick, e.kind, e.def, e.owner, e.slot, e.durability, e.x, e.z
      FROM item_events e
      WHERE e.kind != ${LedgerKind.Destroy}
        AND e.seq = (SELECT MAX(seq) FROM item_events WHERE item_id = e.item_id)
    `);
    this.flushTx = this.db.transaction((count: number, at: number) => {
      for (let i = 0; i < count; i++) {
        this.insertStmt.run(
          this.ids[i],
          this.ticks[i],
          at,
          this.kinds[i],
          this.defs[i],
          this.owners[i],
          this.slots[i],
          this.durs[i],
          this.xs[i],
          this.zs[i],
        );
        // EA17: mirror the latest state into item_latest.
        if (this.kinds[i] === LedgerKind.Destroy) {
          this.latestDeleteStmt.run(this.ids[i]);
        } else {
          this.latestUpsertStmt.run(
            this.ids[i],
            this.ticks[i],
            this.kinds[i],
            this.defs[i],
            this.owners[i],
            this.slots[i],
            this.durs[i],
            this.xs[i],
            this.zs[i],
          );
        }
      }
    });
  }

  /** Events recorded and not yet written. */
  get pending(): number {
    return this.n;
  }

  /** Append an event (in memory until the next flush). */
  record(
    kind: LedgerKindCode,
    id: number,
    def: number,
    owner: number,
    slot: number,
    durability: number,
    x = 0,
    z = 0,
  ): void {
    if (this.n === this.capacity) this.grow();
    const i = this.n++;
    this.kinds[i] = kind;
    this.ids[i] = id;
    this.ticks[i] = this.tick;
    this.defs[i] = def;
    this.owners[i] = owner;
    this.slots[i] = slot;
    this.durs[i] = durability;
    this.xs[i] = x;
    this.zs[i] = z;
  }

  /** Write every recorded event in one transaction. Returns how many. */
  flush(): number {
    const count = this.n;
    if (count === 0) return 0;
    this.flushTx(count, Date.now());
    this.n = 0;
    return count;
  }

  /** Every item that exists, as of its latest event (tombstoned items left out). */
  load(): ItemRow[] {
    return this.liveStmt.all() as ItemRow[];
  }

  /** Highest item id ever written, destroyed ones included (ids are never reused). */
  maxItemId(): number {
    return (this.maxIdStmt.get() as { id: number }).id;
  }

  /** Events written. */
  count(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

  close(): void {
    if (this.ownsDb && this.db.open) this.db.close();
  }

  private grow(): void {
    const cap = this.capacity * 2;
    const g = <T extends Uint8Array | Uint32Array | Float64Array | Int16Array | Float32Array>(
      a: T,
      make: (n: number) => T,
    ): T => {
      const b = make(cap);
      b.set(a as never);
      return b;
    };
    this.kinds = g(this.kinds, (n) => new Uint8Array(n));
    this.ids = g(this.ids, (n) => new Uint32Array(n));
    this.ticks = g(this.ticks, (n) => new Uint32Array(n));
    this.defs = g(this.defs, (n) => new Uint32Array(n));
    this.owners = g(this.owners, (n) => new Float64Array(n));
    this.slots = g(this.slots, (n) => new Int16Array(n));
    this.durs = g(this.durs, (n) => new Float32Array(n));
    this.xs = g(this.xs, (n) => new Float32Array(n));
    this.zs = g(this.zs, (n) => new Float32Array(n));
    this.capacity = cap;
  }
}
