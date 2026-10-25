/**
 * Persistent Data Plane & Inventory Worker (`persist-worker.ts`)
 * (ENGINE_IMPLEMENTATION_SPEC.md §7).
 *
 * Isolates disk I/O and transactional state mutations from the 30Hz Simulation Thread.
 * Runs an embedded SurrealDB engine (`@surrealdb/node`, supporting both `mem://` and
 * `rocksdb://`) inside the Persistence Worker Thread, draining the secondary lockless
 * `AtomicSPSCTransactionQueue` and executing ACID entity checkpoints, inventory slot
 * allocations, and relational graph linkages (`entity->owns->inventory_slot`).
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeEngines } from "@surrealdb/node";
import { createRemoteEngines, RecordId, Surreal } from "surrealdb";
import {
  DATA_PLANE_ENTITY_CAPACITY,
  TELEMETRY_SLOTS,
  attachSharedMemoryPlane,
  type SharedMemoryPlaneViews,
} from "./sab-store.js";
import {
  AtomicSPSCTransactionQueue,
  PERSIST_TX_KIND,
  type PersistTransaction,
} from "./lockless-ring.js";
import { DEFAULT_PERSIST_RING_CAPACITY } from "./sim-worker.js";

export const PERSIST_SCHEMA_SURREALQL = `
-- =============================================================================
-- 1. ENTITY CORE STATE REGISTRY
-- =============================================================================
DEFINE TABLE entity SCHEMAFULL;

-- Direct 1:1 index mapping to the C++ SharedArrayBuffer entity slot
DEFINE FIELD sab_index ON TABLE entity TYPE int
    ASSERT $value != NONE AND $value >= 0;

-- Tracks the precise timestamp of the last memory-to-disk checkpoint
DEFINE FIELD checkpointed_at ON TABLE entity TYPE datetime
    DEFAULT time::now()
    VALUE time::now();

-- Ensure no two persistent records ever claim the same memory arena index
DEFINE INDEX sab_index_idx ON TABLE entity COLUMNS sab_index UNIQUE;

-- =============================================================================
-- 2. TRANSACTIONAL INVENTORY LEDGER
-- =============================================================================
DEFINE TABLE inventory_slot SCHEMAFULL;

-- Enforces hard boundary limits natively at the database engine layer
DEFINE FIELD capacity ON TABLE inventory_slot TYPE int
    DEFAULT 20
    ASSERT $value > 0;

-- Array of held item objects/identifiers
DEFINE FIELD items ON TABLE inventory_slot TYPE array
    DEFAULT [];

-- =============================================================================
-- 3. GRAPH RELATIONAL LINKAGE (ENTITY -> INVENTORY)
-- =============================================================================
DEFINE TABLE owns SCHEMAFULL TYPE RELATION IN entity OUT inventory_slot;

-- Guarantee an inventory container is bound to exactly one owning entity
DEFINE INDEX structural_ownership ON TABLE owns COLUMNS in, out UNIQUE;
`;

/** Load `persist/schema.surrealql` from disk if present, otherwise return embedded constant. */
export function loadPersistSchemaSurrealQL(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, "./persist/schema.surrealql"),
      path.resolve(here, "../src/persist/schema.surrealql"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, "utf8");
      }
    }
  } catch {
    // Fallback to inline constant
  }
  return PERSIST_SCHEMA_SURREALQL;
}

export interface PersistWorkerConfig {
  sharedMemory: SharedArrayBuffer;
  entityCapacity?: number;
  persistRingCapacity?: number;
  dbUrl?: string;
  namespace?: string;
  database?: string;
  pollIntervalMs?: number;
}

export interface EntityPersistRecord {
  id?: unknown;
  sab_index: number;
  checkpointed_at: string | Date;
}

export interface InventorySlotRecord {
  id?: unknown;
  capacity: number;
  items: unknown[];
}

export class PersistenceWorkerRuntime {
  public readonly views: SharedMemoryPlaneViews;
  public readonly persistQueue: AtomicSPSCTransactionQueue;
  public readonly db: Surreal;
  public readonly dbUrl: string;
  public readonly namespace: string;
  public readonly database: string;
  public readonly pollIntervalMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private connected = false;

  constructor(config: PersistWorkerConfig) {
    const entityCapacity = config.entityCapacity ?? DATA_PLANE_ENTITY_CAPACITY;
    this.views = attachSharedMemoryPlane(config.sharedMemory, entityCapacity);
    this.persistQueue = new AtomicSPSCTransactionQueue(
      config.sharedMemory,
      this.views.offsets.PERSIST_RING,
      config.persistRingCapacity ?? DEFAULT_PERSIST_RING_CAPACITY,
    );
    this.db = new Surreal({
      engines: { ...createRemoteEngines(), ...createNodeEngines() },
    });
    this.dbUrl = config.dbUrl ?? "mem://";
    this.namespace = config.namespace ?? "nexus_engine";
    this.database = config.database ?? "hybrid_plane";
    this.pollIntervalMs = config.pollIntervalMs ?? 10;
  }

  /** Connect to embedded SurrealDB (`mem://` or `rocksdb://`) and apply `schema.surrealql`. */
  public async init(): Promise<void> {
    if (this.connected) return;
    await this.db.connect(this.dbUrl);
    await this.db.use({ namespace: this.namespace, database: this.database });
    await this.db.query(loadPersistSchemaSurrealQL());
    this.connected = true;
  }

  /** Deterministic record IDs mapped 1:1 to `sab_index`. */
  public entityRecordId(sabIndex: number): RecordId {
    return new RecordId("entity", `e_${sabIndex}`);
  }

  public slotRecordId(sabIndex: number): RecordId {
    return new RecordId("inventory_slot", `slot_${sabIndex}`);
  }

  /** Execute a single persistence transaction against embedded SurrealDB. */
  public async executeTransaction(tx: PersistTransaction): Promise<void> {
    if (!this.connected) {
      await this.init();
    }

    const eid = this.entityRecordId(tx.sabIndex);
    const sid = this.slotRecordId(tx.sabIndex);

    switch (tx.kind) {
      case PERSIST_TX_KIND.ENTITY_CHECKPOINT: {
        await this.db.query(
          `UPSERT $eid CONTENT { sab_index: $sabIndex, checkpointed_at: time::now() };`,
          { eid, sabIndex: tx.sabIndex },
        );
        break;
      }

      case PERSIST_TX_KIND.INVENTORY_INIT: {
        const capacity = tx.paramA > 0 ? tx.paramA : 20;
        await this.db.query(
          `
          BEGIN TRANSACTION;
          UPSERT $eid CONTENT { sab_index: $sabIndex, checkpointed_at: time::now() };
          UPSERT $sid CONTENT { capacity: $capacity, items: [] };
          RELATE $eid->owns->$sid;
          COMMIT TRANSACTION;
          `,
          { eid, sid, sabIndex: tx.sabIndex, capacity },
        );
        break;
      }

      case PERSIST_TX_KIND.INVENTORY_ADD_ITEM: {
        const itemCode = `item_${tx.paramA}`;
        const slotRows = await this.db.query<[InventorySlotRecord[]]>(
          `SELECT * FROM $sid;`,
          { sid },
        );
        const existing = slotRows?.[0]?.[0];
        if (!existing) {
          await this.db.query(
            `
            BEGIN TRANSACTION;
            UPSERT $eid CONTENT { sab_index: $sabIndex, checkpointed_at: time::now() };
            UPSERT $sid CONTENT { capacity: 20, items: [$itemCode] };
            RELATE $eid->owns->$sid;
            COMMIT TRANSACTION;
            `,
            { eid, sid, sabIndex: tx.sabIndex, itemCode },
          );
        } else if (existing.items.length < existing.capacity) {
          const nextItems = [...existing.items, itemCode];
          await this.db.query(`UPDATE $sid SET items = $nextItems;`, { sid, nextItems });
        }
        break;
      }

      case PERSIST_TX_KIND.INVENTORY_TRANSFER: {
        const targetSabIndex = tx.paramA;
        const itemCode = `item_${tx.paramB}`;
        const targetEid = this.entityRecordId(targetSabIndex);
        const targetSid = this.slotRecordId(targetSabIndex);

        const [fromRows, toRows] = await this.db.query<
          [InventorySlotRecord[], InventorySlotRecord[]]
        >(`SELECT * FROM $sid; SELECT * FROM $targetSid;`, { sid, targetSid });
        const fromSlot = fromRows?.[0];
        const toSlot = toRows?.[0];
        if (!fromSlot || !toSlot) break;

        const itemIdx = fromSlot.items.indexOf(itemCode);
        if (itemIdx === -1 || toSlot.items.length >= toSlot.capacity) break;

        const nextFrom = fromSlot.items.filter((_, idx) => idx !== itemIdx);
        const nextTo = [...toSlot.items, itemCode];

        await this.db.query(
          `
          BEGIN TRANSACTION;
          UPDATE $sid SET items = $nextFrom;
          UPDATE $targetSid SET items = $nextTo;
          UPDATE $eid SET checkpointed_at = time::now();
          UPDATE $targetEid SET checkpointed_at = time::now();
          COMMIT TRANSACTION;
          `,
          { sid, targetSid, eid, targetEid, nextFrom, nextTo },
        );
        break;
      }
    }

    Atomics.add(this.views.telemetryView, TELEMETRY_SLOTS.PERSIST_COMMITTED, 1);
  }

  /** Drain all currently queued transactions from the secondary lockless ring. */
  public async drainPendingTransactions(maxBatch: number = 256): Promise<number> {
    while (this.draining) {
      await new Promise((r) => setTimeout(r, 2));
    }
    this.draining = true;
    let processed = 0;
    try {
      while (processed < maxBatch) {
        const tx = this.persistQueue.dequeue();
        if (tx === null) break;
        await this.executeTransaction(tx);
        processed++;
      }
    } finally {
      this.draining = false;
    }
    return processed;
  }

  /** Query an entity record by its `sab_index`. */
  public async getEntityBySabIndex(sabIndex: number): Promise<EntityPersistRecord | null> {
    const res = await this.db.query<[EntityPersistRecord[]]>(
      `SELECT * FROM entity WHERE sab_index = $sabIndex LIMIT 1;`,
      { sabIndex },
    );
    return res?.[0]?.[0] ?? null;
  }

  /** Query the inventory slots owned by the entity at `sabIndex` via the `->owns->inventory_slot` graph edge. */
  public async getOwnedInventory(sabIndex: number): Promise<InventorySlotRecord[]> {
    const eid = this.entityRecordId(sabIndex);
    const res = await this.db.query<[{ slots?: InventorySlotRecord[] }[]]>(
      `SELECT ->owns->inventory_slot.* AS slots FROM $eid;`,
      { eid },
    );
    return res?.[0]?.[0]?.slots ?? [];
  }

  /** Start background polling of the secondary lockless transaction ring. */
  public start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      if (Atomics.load(this.views.telemetryView, TELEMETRY_SLOTS.SHUTDOWN_SIGNAL) !== 0) {
        void this.stop();
        return;
      }
      void this.drainPendingTransactions();
    }, this.pollIntervalMs);
  }

  /** Stop polling and close the embedded SurrealDB instance. */
  public async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.draining) {
      await new Promise((r) => setTimeout(r, 2));
    }
    await this.drainPendingTransactions();
    if (this.connected) {
      await this.db.close();
      this.connected = false;
    }
  }
}

// Worker thread auto-bootstrap when spawned via `new Worker("./persist-worker.js", { workerData })`
if (!isMainThread && workerData && workerData.sharedMemory instanceof SharedArrayBuffer) {
  const runtime = new PersistenceWorkerRuntime({
    sharedMemory: workerData.sharedMemory,
    entityCapacity: workerData.entityCapacity,
    persistRingCapacity: workerData.persistRingCapacity,
    dbUrl: workerData.dbUrl,
    namespace: workerData.namespace,
    database: workerData.database,
    pollIntervalMs: workerData.pollIntervalMs,
  });

  void runtime.init().then(() => {
    if (workerData.autoStart !== false) {
      runtime.start();
    }
    parentPort?.postMessage({ type: "ready", dbUrl: runtime.dbUrl });
  });

  parentPort?.on("message", (msg: { type?: string }) => {
    if (msg?.type === "drain") {
      void runtime.drainPendingTransactions().then((count) => {
        parentPort?.postMessage({ type: "drained", count });
      });
    } else if (msg?.type === "stop") {
      void runtime.stop().then(() => {
        parentPort?.postMessage({ type: "stopped" });
        process.exit(0);
      });
    }
  });
}
