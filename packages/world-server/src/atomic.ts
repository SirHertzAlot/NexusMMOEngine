/**
 * Atomic operations (ATOMIC-OPERATIONS-SPEC, slice A1): the pure
 * transition logic behind the six value-moving WorldStore operations.
 *
 * This module is the single definition of each operation's semantics.
 * Both stores run it:
 *
 * - MemoryWorldStore runs it over its in-memory maps with no awaits
 *   between validation and mutation — one critical section.
 * - SurrealWorldStore runs it over rows fetched in one query, then
 *   persists the resulting records and ledger entries in ONE
 *   transaction whose writes are version-guarded (a record changed
 *   since the read aborts the whole transaction).
 *
 * The governing invariant — one operation = one WorldStore call = one
 * DB transaction — lives in the stores; this module guarantees the
 * other half: a transition validates EVERYTHING before it produces a
 * commit, so a rejected operation's commit is empty by construction
 * and every participating record (and the ledger) stays untouched.
 *
 * Character state shape: the world record's opaque `state` object
 * carries `gold` (integer >= 0) and `inventory` (InventoryItem[]) for
 * these operations. Every other key is preserved verbatim — the
 * operations never interpret the rest of the record.
 */
import {
  AUCTION_HOUSE_CUT_RATE,
  AUCTION_HOUSE_SINK,
  type AtomicLedgerEntry,
  type AtomicOpKind,
  type AtomicRejectionCode,
  type AuctionSettleInput,
  type CharacterSessionLock,
  type CharacterStateRecord,
  type CraftExecuteInput,
  type InventoryItem,
  type InventoryMutateInput,
  type LootGrantInput,
  type ParticipantFence,
  type TradeCommitInput,
  type VendorTransactInput,
} from "./types.js";

/** A ledger entry before the store assigns its seq / timestamp. */
export type AtomicLedgerDraft = Omit<AtomicLedgerEntry, "seq" | "at">;

export interface AtomicCommit {
  /** New character record versions to persist (version already bumped). */
  records: CharacterStateRecord[];
  /** Item/gold movements to append to the world item ledger, in order. */
  ledger: AtomicLedgerDraft[];
  /**
   * Gold credits owed to characters whose records could not be paid
   * directly in this commit (auctionSettle's pending seller path);
   * the stores persist them in the same transaction / critical
   * section and stamp `createdAt`. Empty for every other operation.
   */
  pendingCredits: Array<{ opId: string; characterId: number; amount: number }>;
}

export type AtomicOutcome =
  | { ok: true; commit: AtomicCommit }
  | { ok: false; rejection: AtomicRejectionCode; message: string };

export interface AtomicContext {
  /** The authenticated region initiating the operation. */
  regionId: string;
  now: number;
  /** Current record per participating character (null when none). */
  records: ReadonlyMap<number, CharacterStateRecord | null>;
  /** Current session lock per participating character (null when unheld). */
  locks: ReadonlyMap<number, CharacterSessionLock | null>;
}

const reject = (rejection: AtomicRejectionCode, message: string): AtomicOutcome => ({
  ok: false,
  rejection,
  message,
});

/** Working copy of one character's gold + inventory. */
interface CharView {
  characterId: number;
  version: number;
  gold: number;
  inventory: InventoryItem[];
  /** The record's other state keys, preserved verbatim. */
  rest: Record<string, unknown>;
}

function viewOf(ctx: AtomicContext, characterId: number): CharView {
  const rec = ctx.records.get(characterId) ?? null;
  if (rec === null) {
    return { characterId, version: 0, gold: 0, inventory: [], rest: {} };
  }
  const state =
    rec.state !== null && typeof rec.state === "object" && !Array.isArray(rec.state)
      ? (rec.state as Record<string, unknown>)
      : {};
  const { gold, inventory, ...rest } = state;
  return {
    characterId,
    version: rec.version,
    gold: typeof gold === "number" && Number.isFinite(gold) ? Math.floor(gold) : 0,
    inventory: Array.isArray(inventory)
      ? (inventory as InventoryItem[]).map((i) => ({ ...i }))
      : [],
    rest: { ...rest },
  };
}

function recordOf(ctx: AtomicContext, view: CharView, epoch: number): CharacterStateRecord {
  return {
    characterId: view.characterId,
    state: { ...view.rest, gold: view.gold, inventory: view.inventory.map((i) => ({ ...i })) },
    version: view.version + 1,
    epoch,
    regionId: ctx.regionId,
    updatedAt: ctx.now,
  };
}

const charRef = (characterId: number): string => `char:${characterId}`;

/**
 * The fencing check for one participant, in check order: a missing or
 * expired lock is a LOCK_CONFLICT; a held lock at a different epoch
 * than the caller's is EPOCH_STALE; a record version other than the
 * expected one is VERSION_CONFLICT. Cross-shard is the normal case,
 * so the lock's holder region is not required to be the caller — the
 * epoch is the fence (the caller must know the current one).
 */
function checkFence(
  ctx: AtomicContext,
  fence: ParticipantFence,
): { rejection: AtomicRejectionCode; message: string } | null {
  const lock = ctx.locks.get(fence.characterId) ?? null;
  if (lock === null) {
    return {
      rejection: "LOCK_CONFLICT",
      message: `character ${fence.characterId} is not locked`,
    };
  }
  if (lock.expiresAt <= ctx.now) {
    return {
      rejection: "LOCK_CONFLICT",
      message: `character lock for ${fence.characterId} has expired`,
    };
  }
  if (lock.epoch !== fence.epoch) {
    return {
      rejection: "EPOCH_STALE",
      message: `stale lock epoch ${fence.epoch} for character ${fence.characterId} (current ${lock.epoch})`,
    };
  }
  const version = ctx.records.get(fence.characterId)?.version ?? 0;
  if (version !== fence.expectedVersion) {
    return {
      rejection: "VERSION_CONFLICT",
      message: `character ${fence.characterId} version conflict: expected ${fence.expectedVersion}, current ${version}`,
    };
  }
  return null;
}

function fenceAll(
  ctx: AtomicContext,
  fences: ParticipantFence[],
): AtomicOutcome | null {
  for (const f of fences) {
    const bad = checkFence(ctx, f);
    if (bad !== null) return reject(bad.rejection, bad.message);
  }
  return null;
}

function lowestFreeSlot(inventory: InventoryItem[]): number {
  const used = new Set(inventory.map((i) => i.slot));
  let s = 0;
  while (used.has(s)) s += 1;
  return s;
}

function findItem(view: CharView, instanceId: string): InventoryItem | undefined {
  return view.inventory.find((i) => i.instanceId === instanceId);
}

/** Remove `count` units of an instance from a view; false when short. */
function takeFrom(view: CharView, instanceId: string, count: number): InventoryItem | null {
  const idx = view.inventory.findIndex((i) => i.instanceId === instanceId);
  if (idx < 0) return null;
  const item = view.inventory[idx];
  if (item.count < count) return null;
  const taken: InventoryItem = { ...item, count };
  if (item.count === count) view.inventory.splice(idx, 1);
  else view.inventory[idx] = { ...item, count: item.count - count };
  return taken;
}

/** Give a whole instance to a view at an explicit or lowest free slot. */
function giveTo(
  view: CharView,
  item: InventoryItem,
  slot: number | undefined,
): { rejection: AtomicRejectionCode; message: string } | null {
  if (findItem(view, item.instanceId) !== undefined) {
    return {
      rejection: "VERSION_CONFLICT",
      message: `item instance ${item.instanceId} already exists in character ${view.characterId}'s inventory`,
    };
  }
  const at = slot ?? lowestFreeSlot(view.inventory);
  if (view.inventory.some((i) => i.slot === at)) {
    return {
      rejection: "VERSION_CONFLICT",
      message: `slot ${at} is occupied in character ${view.characterId}'s inventory`,
    };
  }
  view.inventory.push({ ...item, slot: at });
  return null;
}

// ---------------------------------------------------------------------------
// tradeCommit: two characters exchange declared item sets and gold,
// both directions, all-or-nothing.
// ---------------------------------------------------------------------------

export function applyTradeCommit(
  ctx: AtomicContext,
  input: TradeCommitInput,
  op: AtomicOpKind = "tradeCommit",
): AtomicOutcome {
  if (input.a.characterId === input.b.characterId) {
    return reject("VERSION_CONFLICT", "trade participants must be different characters");
  }
  const fenced = fenceAll(ctx, [input.a, input.b]);
  if (fenced !== null) return fenced;
  const a = viewOf(ctx, input.a.characterId);
  const b = viewOf(ctx, input.b.characterId);
  if (a.gold < input.aGivesGold) {
    return reject(
      "INSUFFICIENT_FUNDS",
      `character ${a.characterId} has ${a.gold} gold, trade needs ${input.aGivesGold}`,
    );
  }
  if (b.gold < input.bGivesGold) {
    return reject(
      "INSUFFICIENT_FUNDS",
      `character ${b.characterId} has ${b.gold} gold, trade needs ${input.bGivesGold}`,
    );
  }
  // Simulate every item move on the working copies first: a missing
  // item on either side rejects the whole trade with nothing applied.
  const aGives: InventoryItem[] = [];
  for (const id of input.aGivesItems) {
    const taken = takeWhole(a, id);
    if (taken === null) {
      return reject("ITEM_NOT_PRESENT", `item ${id} is not in character ${a.characterId}'s inventory`);
    }
    aGives.push(taken);
  }
  const bGives: InventoryItem[] = [];
  for (const id of input.bGivesItems) {
    const taken = takeWhole(b, id);
    if (taken === null) {
      return reject("ITEM_NOT_PRESENT", `item ${id} is not in character ${b.characterId}'s inventory`);
    }
    bGives.push(taken);
  }
  const ledger: AtomicLedgerDraft[] = [];
  if (input.aGivesGold > 0) {
    a.gold -= input.aGivesGold;
    b.gold += input.aGivesGold;
    ledger.push({
      opId: input.opId, op, kind: "gold",
      from: charRef(a.characterId), to: charRef(b.characterId), amount: input.aGivesGold,
    });
  }
  if (input.bGivesGold > 0) {
    b.gold -= input.bGivesGold;
    a.gold += input.bGivesGold;
    ledger.push({
      opId: input.opId, op, kind: "gold",
      from: charRef(b.characterId), to: charRef(a.characterId), amount: input.bGivesGold,
    });
  }
  for (const item of aGives) {
    const bad = giveTo(b, item, undefined);
    if (bad !== null) return reject(bad.rejection, bad.message);
    ledger.push({
      opId: input.opId, op, kind: "item", instanceId: item.instanceId, def: item.def,
      from: charRef(a.characterId), to: charRef(b.characterId), count: item.count,
    });
  }
  for (const item of bGives) {
    const bad = giveTo(a, item, undefined);
    if (bad !== null) return reject(bad.rejection, bad.message);
    ledger.push({
      opId: input.opId, op, kind: "item", instanceId: item.instanceId, def: item.def,
      from: charRef(b.characterId), to: charRef(a.characterId), count: item.count,
    });
  }
  return {
    ok: true,
    commit: {
      records: [recordOf(ctx, a, input.a.epoch), recordOf(ctx, b, input.b.epoch)],
      ledger,
      pendingCredits: [],
    },
  };
}

/** Take an entire stack out of a view; null when the instance is absent. */
function takeWhole(view: CharView, instanceId: string): InventoryItem | null {
  const idx = view.inventory.findIndex((i) => i.instanceId === instanceId);
  if (idx < 0) return null;
  const [item] = view.inventory.splice(idx, 1);
  return { ...item };
}

// ---------------------------------------------------------------------------
// vendorTransact: one character and a vendor — buy (gold -> item) or
// sell (item -> gold). The vendor is a world-tier system identity;
// it never runs out of gold or stock, so only the character's record
// changes and the transaction shape is unchanged.
// ---------------------------------------------------------------------------

export function applyVendorTransact(
  ctx: AtomicContext,
  input: VendorTransactInput,
): AtomicOutcome {
  const fenced = fenceAll(ctx, [input.participant]);
  if (fenced !== null) return fenced;
  const v = viewOf(ctx, input.participant.characterId);
  const vendor = `vendor:${input.vendorId}`;
  const ledger: AtomicLedgerDraft[] = [];
  if (input.direction === "buy") {
    if (v.gold < input.price) {
      return reject(
        "INSUFFICIENT_FUNDS",
        `character ${v.characterId} has ${v.gold} gold, vendor price is ${input.price}`,
      );
    }
    const bad = giveTo(
      v,
      { instanceId: input.instanceId, def: input.def, slot: 0, count: 1 },
      input.slot,
    );
    if (bad !== null) return reject(bad.rejection, bad.message);
    v.gold -= input.price;
    ledger.push({
      opId: input.opId, op: "vendorTransact", kind: "item", instanceId: input.instanceId,
      def: input.def, from: vendor, to: charRef(v.characterId), count: 1,
    });
    if (input.price > 0) {
      ledger.push({
        opId: input.opId, op: "vendorTransact", kind: "gold",
        from: charRef(v.characterId), to: vendor, amount: input.price,
      });
    }
  } else {
    const taken = takeWhole(v, input.instanceId);
    if (taken === null) {
      return reject(
        "ITEM_NOT_PRESENT",
        `item ${input.instanceId} is not in character ${v.characterId}'s inventory`,
      );
    }
    v.gold += input.price;
    ledger.push({
      opId: input.opId, op: "vendorTransact", kind: "item", instanceId: taken.instanceId,
      def: taken.def, from: charRef(v.characterId), to: vendor, count: taken.count,
    });
    if (input.price > 0) {
      ledger.push({
        opId: input.opId, op: "vendorTransact", kind: "gold",
        from: vendor, to: charRef(v.characterId), amount: input.price,
      });
    }
  }
  return {
    ok: true,
    commit: { records: [recordOf(ctx, v, input.participant.epoch)], ledger, pendingCredits: [] },
  };
}

// ---------------------------------------------------------------------------
// auctionSettle: buyer pays the price, the item moves buyer-ward, and
// the seller receives the price NET of the house cut — parity with
// the standalone auction house (engine-core's AUCTION_FEE): the fee
// is floor(price * AUCTION_HOUSE_CUT_RATE), ledgered to
// AUCTION_HOUSE_SINK and granted nowhere — a pure gold sink. The
// buyer is always debited the full price; debit = proceeds + fee.
//
// The BUYER is fenced in full, as for every other operation. The
// SELLER is the exception (fleet auction parity): a buyout must not
// fail just because the seller is offline or playing on another
// region, so the seller's presented epoch/expectedVersion are not
// checked — the store's read-fresh + version-guarded write is the
// concurrency control. Two seller paths:
//
// - DIRECT: the seller has no live lock (offline / expired), or its
//   live lock is held by the initiating region and the presented
//   fence checks out in full. The proceeds land in the seller's
//   record inside this commit.
// - PENDING: the seller's live lock is held by another region, or
//   held by the caller but the presented fence is invalid. The
//   seller's record is written with the item out ONLY (gold
//   untouched — its own region's caches own that balance right now)
//   and the proceeds become a pending credit, drained into the
//   record by the seller's next putCharacterState / lock acquire
//   (see WorldStore.applyPendingCredits).
// ---------------------------------------------------------------------------

export function applyAuctionSettle(
  ctx: AtomicContext,
  input: AuctionSettleInput,
): AtomicOutcome {
  if (input.buyer.characterId === input.seller.characterId) {
    return reject("VERSION_CONFLICT", "auction buyer and seller must be different characters");
  }
  const buyerFenced = checkFence(ctx, input.buyer);
  if (buyerFenced !== null) return reject(buyerFenced.rejection, buyerFenced.message);
  const buyer = viewOf(ctx, input.buyer.characterId);
  const seller = viewOf(ctx, input.seller.characterId);
  const item = findItem(seller, input.instanceId);
  if (item === undefined) {
    return reject(
      "ITEM_NOT_PRESENT",
      `item ${input.instanceId} is not in character ${seller.characterId}'s inventory`,
    );
  }
  if (buyer.gold < input.price) {
    return reject(
      "INSUFFICIENT_FUNDS",
      `character ${buyer.characterId} has ${buyer.gold} gold, auction price is ${input.price}`,
    );
  }
  const fee = Math.floor(input.price * AUCTION_HOUSE_CUT_RATE);
  const proceeds = input.price - fee;
  const sellerLock = ctx.locks.get(input.seller.characterId) ?? null;
  const sellerLive = sellerLock !== null && sellerLock.expiresAt > ctx.now;
  const directOnline =
    sellerLive &&
    sellerLock.regionId === ctx.regionId &&
    checkFence(ctx, input.seller) === null;
  const direct = !sellerLive || directOnline;
  // The epoch stamped on the seller's written record: the presented
  // fence's on the direct-online path; the record's own epoch when
  // offline (0 when there is no record — unreachable in practice,
  // the item check above rejects first); the live lock's epoch on
  // the pending path (that lock's holder owns the record).
  const sellerEpoch = direct
    ? directOnline
      ? input.seller.epoch
      : (ctx.records.get(input.seller.characterId)?.epoch ?? 0)
    : sellerLock!.epoch;
  const taken = takeWhole(seller, input.instanceId)!;
  const bad = giveTo(buyer, taken, undefined);
  if (bad !== null) return reject(bad.rejection, bad.message);
  buyer.gold -= input.price;
  if (direct) seller.gold += proceeds;
  const pendingCredits =
    !direct && proceeds > 0
      ? [{ opId: input.opId, characterId: input.seller.characterId, amount: proceeds }]
      : [];
  const ledger: AtomicLedgerDraft[] = [
    {
      opId: input.opId, op: "auctionSettle", kind: "item", instanceId: taken.instanceId,
      def: taken.def, from: charRef(seller.characterId), to: charRef(buyer.characterId),
      count: taken.count,
    },
  ];
  if (proceeds > 0) {
    ledger.push({
      opId: input.opId, op: "auctionSettle", kind: "gold",
      from: charRef(buyer.characterId), to: charRef(seller.characterId), amount: proceeds,
    });
  }
  if (fee > 0) {
    ledger.push({
      opId: input.opId, op: "auctionSettle", kind: "gold",
      from: charRef(buyer.characterId), to: AUCTION_HOUSE_SINK, amount: fee,
    });
  }
  return {
    ok: true,
    commit: {
      records: [
        recordOf(ctx, buyer, input.buyer.epoch),
        recordOf(ctx, seller, sellerEpoch),
      ],
      ledger,
      pendingCredits,
    },
  };
}

// ---------------------------------------------------------------------------
// craftExecute: one character consumes the recipe's input items (and
// an optional gold fee, a declared sink) and produces the outputs.
// ---------------------------------------------------------------------------

const CRAFT_SYSTEM = "system:craft";

export function applyCraftExecute(
  ctx: AtomicContext,
  input: CraftExecuteInput,
): AtomicOutcome {
  const fenced = fenceAll(ctx, [input.participant]);
  if (fenced !== null) return fenced;
  const v = viewOf(ctx, input.participant.characterId);
  if (v.gold < input.goldFee) {
    return reject(
      "INSUFFICIENT_FUNDS",
      `character ${v.characterId} has ${v.gold} gold, craft fee is ${input.goldFee}`,
    );
  }
  const ledger: AtomicLedgerDraft[] = [];
  for (const c of input.consumes) {
    const taken = takeFrom(v, c.instanceId, c.count);
    if (taken === null) {
      return reject(
        "ITEM_NOT_PRESENT",
        `craft input ${c.instanceId} (x${c.count}) is not in character ${v.characterId}'s inventory`,
      );
    }
    ledger.push({
      opId: input.opId, op: "craftExecute", kind: "item", instanceId: taken.instanceId,
      def: taken.def, from: charRef(v.characterId), to: CRAFT_SYSTEM, count: c.count,
    });
  }
  for (const o of input.outputs) {
    const bad = giveTo(
      v,
      { instanceId: o.instanceId, def: o.def, slot: 0, count: o.count ?? 1 },
      o.slot,
    );
    if (bad !== null) return reject(bad.rejection, bad.message);
    ledger.push({
      opId: input.opId, op: "craftExecute", kind: "item", instanceId: o.instanceId,
      def: o.def, from: CRAFT_SYSTEM, to: charRef(v.characterId), count: o.count ?? 1,
    });
  }
  v.gold -= input.goldFee;
  if (input.goldFee > 0) {
    ledger.push({
      opId: input.opId, op: "craftExecute", kind: "gold",
      from: charRef(v.characterId), to: CRAFT_SYSTEM, amount: input.goldFee,
    });
  }
  return {
    ok: true,
    commit: { records: [recordOf(ctx, v, input.participant.epoch)], ledger, pendingCredits: [] },
  };
}

// ---------------------------------------------------------------------------
// lootGrant: system -> character. Creates the item instance and
// assigns ownership atomically (the boss-drop path).
// ---------------------------------------------------------------------------

export function applyLootGrant(
  ctx: AtomicContext,
  input: LootGrantInput,
): AtomicOutcome {
  const fenced = fenceAll(ctx, [input.participant]);
  if (fenced !== null) return fenced;
  const v = viewOf(ctx, input.participant.characterId);
  const bad = giveTo(
    v,
    { instanceId: input.instanceId, def: input.def, slot: 0, count: input.count ?? 1 },
    input.slot,
  );
  if (bad !== null) return reject(bad.rejection, bad.message);
  return {
    ok: true,
    commit: {
      records: [recordOf(ctx, v, input.participant.epoch)],
      ledger: [
        {
          opId: input.opId, op: "lootGrant", kind: "item", instanceId: input.instanceId,
          def: input.def, from: input.sourceId, to: charRef(v.characterId),
          count: input.count ?? 1,
        },
      ],
      pendingCredits: [],
    },
  };
}

// ---------------------------------------------------------------------------
// inventoryMutate: move / stack-merge / equip-swap within one
// character's own inventory, as one version-checked mutation.
// ---------------------------------------------------------------------------

export function applyInventoryMutate(
  ctx: AtomicContext,
  input: InventoryMutateInput,
): AtomicOutcome {
  const fenced = fenceAll(ctx, [input.participant]);
  if (fenced !== null) return fenced;
  const v = viewOf(ctx, input.participant.characterId);
  const ledger: AtomicLedgerDraft[] = [];
  const ref = charRef(v.characterId);
  for (const m of input.mutations) {
    if (m.kind === "move") {
      const item = findItem(v, m.instanceId);
      if (item === undefined) {
        return reject("ITEM_NOT_PRESENT", `item ${m.instanceId} is not in character ${v.characterId}'s inventory`);
      }
      const occupant = v.inventory.find((i) => i.slot === m.toSlot && i.instanceId !== m.instanceId);
      if (occupant !== undefined) {
        return reject("VERSION_CONFLICT", `slot ${m.toSlot} is occupied by item ${occupant.instanceId}`);
      }
      const fromSlot = item.slot;
      item.slot = m.toSlot;
      ledger.push({
        opId: input.opId, op: "inventoryMutate", kind: "item", instanceId: item.instanceId,
        def: item.def, from: ref, to: ref, count: item.count, fromSlot, toSlot: m.toSlot,
      });
    } else if (m.kind === "swap") {
      const a = findItem(v, m.aInstanceId);
      if (a === undefined) {
        return reject("ITEM_NOT_PRESENT", `item ${m.aInstanceId} is not in character ${v.characterId}'s inventory`);
      }
      const b = findItem(v, m.bInstanceId);
      if (b === undefined) {
        return reject("ITEM_NOT_PRESENT", `item ${m.bInstanceId} is not in character ${v.characterId}'s inventory`);
      }
      const aSlot = a.slot;
      const bSlot = b.slot;
      a.slot = bSlot;
      b.slot = aSlot;
      ledger.push(
        {
          opId: input.opId, op: "inventoryMutate", kind: "item", instanceId: a.instanceId,
          def: a.def, from: ref, to: ref, count: a.count, fromSlot: aSlot, toSlot: bSlot,
        },
        {
          opId: input.opId, op: "inventoryMutate", kind: "item", instanceId: b.instanceId,
          def: b.def, from: ref, to: ref, count: b.count, fromSlot: bSlot, toSlot: aSlot,
        },
      );
    } else {
      // merge: the source stack folds into the target stack (same def).
      const from = findItem(v, m.fromInstanceId);
      if (from === undefined) {
        return reject("ITEM_NOT_PRESENT", `item ${m.fromInstanceId} is not in character ${v.characterId}'s inventory`);
      }
      const into = findItem(v, m.intoInstanceId);
      if (into === undefined) {
        return reject("ITEM_NOT_PRESENT", `item ${m.intoInstanceId} is not in character ${v.characterId}'s inventory`);
      }
      if (from.instanceId === into.instanceId || from.def !== into.def) {
        return reject(
          "ITEM_NOT_PRESENT",
          `items ${m.fromInstanceId} and ${m.intoInstanceId} are not one stackable def`,
        );
      }
      const moved = from.count;
      into.count += from.count;
      v.inventory.splice(v.inventory.indexOf(from), 1);
      ledger.push({
        opId: input.opId, op: "inventoryMutate", kind: "item", instanceId: from.instanceId,
        def: from.def, from: ref, to: ref, count: moved, toSlot: into.slot,
      });
    }
  }
  return {
    ok: true,
    commit: { records: [recordOf(ctx, v, input.participant.epoch)], ledger, pendingCredits: [] },
  };
}
