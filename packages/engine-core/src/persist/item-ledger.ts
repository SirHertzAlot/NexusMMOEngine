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

/**
 * One flushed event as stored, `seq` included. `seq` is the table's own
 * PRIMARY KEY — the ledger's natural ordering — and is the sequence the
 * world store dedups on when events are streamed uphill (persistence
 * P2): no parallel counter exists that could drift from it.
 */
export interface LedgerEventRow {
  seq: number;
  itemId: number;
  tick: number;
  committedAt: number;
  kind: LedgerKindCode;
  def: number;
  owner: number;
  slot: number;
  durability: number;
  x: number;
  z: number;
}

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
  private readonly eventsAfterStmt: Database.Statement;
  private readonly importStmt: Database.Statement;
  private readonly flushTx: (n: number, at: number) => void;
  private readonly importTx: (rows: readonly LedgerEventRow[]) => number;

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
      `SELECT item_id AS id, kind, def, owner, slot, durability, x, z FROM item_events e
       WHERE kind != ${LedgerKind.Destroy}
         AND seq = (SELECT MAX(seq) FROM item_events WHERE item_id = e.item_id)
       ORDER BY item_id`,
    );
    this.maxIdStmt = this.db.prepare("SELECT COALESCE(MAX(item_id), 0) AS id FROM item_events");
    this.countStmt = this.db.prepare("SELECT COUNT(*) AS n FROM item_events");
    this.eventsAfterStmt = this.db.prepare(
      `SELECT seq, item_id AS itemId, tick, committed_at AS committedAt, kind, def, owner, slot, durability, x, z
       FROM item_events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
    );
    this.importStmt = this.db.prepare(
      "INSERT OR IGNORE INTO item_events (seq, item_id, tick, committed_at, kind, def, owner, slot, durability, x, z) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.importTx = this.db.transaction((rows: readonly LedgerEventRow[]): number => {
      let inserted = 0;
      for (const row of rows) {
        const info = this.importStmt.run(
          row.seq,
          row.itemId,
          row.tick,
          row.committedAt,
          row.kind,
          row.def,
          row.owner,
          row.slot,
          row.durability,
          row.x,
          row.z,
        );
        inserted += Number(info.changes);
      }
      return inserted;
    });
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

  /**
   * Import events recalled from the world store (persistence P3),
   * preserving each row's own `seq` — the sequence is the event's
   * identity on both tiers, so an import is idempotent: a seq already
   * present locally keeps its first-written row (INSERT OR IGNORE) and
   * is never duplicated, and later locally-flushed events continue
   * after the highest imported seq. Returns how many rows were new.
   * Nothing is recorded in the pending buffer; imported rows are
   * durable immediately and `load()` collapses them exactly like
   * locally-written rows.
   */
  importEvents(rows: readonly LedgerEventRow[]): number {
    if (rows.length === 0) return 0;
    return this.importTx(rows);
  }

  /**
   * Flushed events with `seq > afterSeq`, oldest first, at most `limit`.
   * The uphill shipper (persistence P2) reads the batch it just flushed
   * back through here so the seq it ships is the row's own identity.
   */
  eventsAfter(afterSeq: number, limit: number): LedgerEventRow[] {
    return this.eventsAfterStmt.all(afterSeq, limit) as LedgerEventRow[];
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
