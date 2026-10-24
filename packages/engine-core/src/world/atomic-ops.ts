/**
 * WorldAtomicOps — persistence/atomic slice A2: the region side of the
 * world-tier atomic operations (ATOMIC-OPERATIONS-SPEC, "Region
 * integration").
 *
 * In fleet mode (WORLD_URL set) the economy trade/vendor/auction
 * commit steps, the crafting execution step, and the item grant path
 * route their COMMIT through here: one call here is one WorldClient
 * call is one WorldStore transaction at the world tier. Negotiation,
 * validation UX, and rate limits stay in the region systems where
 * they already live; this class owns only the commit:
 *
 *   1. Fences. Every participant's fence (lock epoch + expected
 *      record version) comes from the P4 session-lock plumbing — the
 *      WorldCharacterSync that holds the character's lock. A
 *      participant this region does not hold (the cross-shard case:
 *      in session on another shard) is fenced from the world's own
 *      lock/state reads, never from a parallel local source. A
 *      participant with no live world lock fails the operation
 *      closed (WorldTransportError 409) before any world call.
 *      ONE exception: the auction SELLER (see `sellerFenceFor`). A
 *      buyout must not fail because the seller logged off or plays
 *      on another shard, so the seller's fence is built from world
 *      reads without throwing and the world tier decides how the
 *      proceeds land (directly, or as a pending credit) — the
 *      buyer, and every other operation's participants, still fail
 *      closed exactly as above.
 *   2. The settled outcome — success OR a typed rejection — is
 *      returned to the caller as a value. A transport failure throws
 *      WorldTransportError, distinguishable from a rejection: an
 *      outage at the commit step is not a settled "no".
 *   3. On success the outcome is recorded with the sync
 *      (`applySettled`): participating records' versions advance and
 *      the local economy caches reconcile to the world's records.
 *      The world's version is truth; the shard's cache reconciles to
 *      it, never the reverse.
 *
 * Fail closed, always: a rejection or an outage commits NOTHING
 * locally — there is no local fallback commit anywhere in this path.
 * Standalone mode never constructs this class (no WORLD_URL, no
 * WorldClient), so region behaviour there is byte-identical.
 *
 * Nothing here runs on the sim tick: callers are gateway/module
 * paths, per the spec's invariants.
 */

import type {
  AtomicOpResult,
  CharacterSessionLock,
  CharacterStateRecord,
  InventoryItem,
  ParticipantFence,
} from "@mmo-engine/world-server";
import {
  WorldTransportError,
  type AuctionSettleRequest,
  type CraftExecuteRequest,
  type InventoryMutateRequest,
  type LootGrantRequest,
  type TradeCommitRequest,
  type VendorTransactRequest,
} from "./client.js";
import type { CharacterEconomyView } from "./character-sync.js";
import type { WalletSystem } from "../economy/wallet.js";
import type { ItemStore } from "../items/item-store.js";
import { LedgerKind } from "../persist/item-ledger.js";

/** The slice of WorldClient the atomic commit path needs. */
export interface AtomicWorldClient {
  tradeCommit(input: TradeCommitRequest): Promise<AtomicOpResult>;
  vendorTransact(input: VendorTransactRequest): Promise<AtomicOpResult>;
  auctionSettle(input: AuctionSettleRequest): Promise<AtomicOpResult>;
  craftExecute(input: CraftExecuteRequest): Promise<AtomicOpResult>;
  lootGrant(input: LootGrantRequest): Promise<AtomicOpResult>;
  inventoryMutate(input: InventoryMutateRequest): Promise<AtomicOpResult>;
  getCharacterLock(characterId: number): Promise<CharacterSessionLock | null>;
  getCharacterState(characterId: number): Promise<CharacterStateRecord | null>;
}

/**
 * The P4 fencing source: the session-lock plumbing that already holds
 * the character. WorldCharacterSync implements this; nothing else
 * may mint a fence for a locally held character.
 */
export interface AtomicFenceSource {
  fence(characterId: number): Promise<ParticipantFence | null>;
  applySettled(result: AtomicOpResult): void;
}

/**
 * The world-tier instance id of a region item: region item ids are
 * positive integers, unique per item ledger, and never reused, so
 * `item-<id>` is a stable world identity for the item's whole life.
 */
export function itemInstanceId(item: number): string {
  return `item-${item}`;
}

/** The region item id behind a world instance id; null for foreign ids. */
export function parseItemInstanceId(instanceId: string): number | null {
  const m = /^item-(\d+)$/.exec(instanceId);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export interface WorldAtomicOpsOptions {
  client: AtomicWorldClient;
  fences: AtomicFenceSource;
  /** Wall clock for cross-shard lock-expiry checks (tests inject). */
  now?: () => number;
}

export class WorldAtomicOps {
  private readonly client: AtomicWorldClient;
  private readonly fences: AtomicFenceSource;
  private readonly now: () => number;

  constructor(opts: WorldAtomicOpsOptions) {
    this.client = opts.client;
    this.fences = opts.fences;
    this.now = opts.now ?? Date.now;
  }

  /**
   * The fence for one participant. Locally held characters are fenced
   * from the sync (held lock epoch + last-seen version). A character
   * held by ANOTHER shard is fenced from the world's own lock and
   * state records — the epoch is the fence, and the world rejects a
   * stale one. No live lock anywhere: fail closed before any commit.
   */
  async fenceFor(characterId: number): Promise<ParticipantFence> {
    const local = await this.fences.fence(characterId);
    if (local !== null) return local;
    const lock = await this.client.getCharacterLock(characterId);
    if (lock === null || lock.expiresAt <= this.now()) {
      throw new WorldTransportError(
        409,
        `character ${characterId} has no live world session lock; atomic operation refused`,
      );
    }
    const record = await this.client.getCharacterState(characterId);
    return {
      characterId,
      epoch: lock.epoch,
      expectedVersion: record?.version ?? 0,
    };
  }

  /** `tradeCommit`: two characters exchange item sets and gold, both ways. */
  async trade(
    input: Omit<TradeCommitRequest, "a" | "b"> & { a: number; b: number },
  ): Promise<AtomicOpResult> {
    const { a, b, ...rest } = input;
    const [fa, fb] = await Promise.all([this.fenceFor(a), this.fenceFor(b)]);
    return this.settle(this.client.tradeCommit({ ...rest, a: fa, b: fb }));
  }

  /** `vendorTransact`: one character buys from or sells to a vendor. */
  async vendor(
    input: Omit<VendorTransactRequest, "participant"> & { character: number },
  ): Promise<AtomicOpResult> {
    const { character, ...rest } = input;
    const participant = await this.fenceFor(character);
    return this.settle(this.client.vendorTransact({ ...rest, participant }));
  }

  /**
   * The auction seller's fence — the one fence that never fails
   * closed. Locally held sellers are fenced from the sync, exactly
   * like any participant. Otherwise the fence is built from the
   * world's own reads WITHOUT throwing: a live lock contributes its
   * epoch; no (or an expired) lock contributes epoch 0; either way
   * the expected version is the world record's current version. The
   * world tier does not fence-check the seller — this fence only
   * tells it which path the proceeds take (see applyAuctionSettle
   * at the world tier: direct vs pending credit).
   */
  private async sellerFenceFor(characterId: number): Promise<ParticipantFence> {
    const local = await this.fences.fence(characterId);
    if (local !== null) return local;
    const lock = await this.client.getCharacterLock(characterId);
    const record = await this.client.getCharacterState(characterId);
    if (lock !== null && lock.expiresAt > this.now()) {
      return {
        characterId,
        epoch: lock.epoch,
        expectedVersion: record?.version ?? 0,
      };
    }
    return { characterId, epoch: 0, expectedVersion: record?.version ?? 0 };
  }

  /** `auctionSettle`: buyer pays, seller receives (net of the house cut), the item moves. */
  async auction(
    input: Omit<AuctionSettleRequest, "buyer" | "seller"> & { buyer: number; seller: number },
  ): Promise<AtomicOpResult> {
    const { buyer, seller, ...rest } = input;
    const [fb, fs] = await Promise.all([this.fenceFor(buyer), this.sellerFenceFor(seller)]);
    return this.settle(this.client.auctionSettle({ ...rest, buyer: fb, seller: fs }));
  }

  /** `craftExecute`: consume inputs (+ optional gold fee), produce outputs. */
  async craft(
    input: Omit<CraftExecuteRequest, "participant"> & { character: number },
  ): Promise<AtomicOpResult> {
    const { character, ...rest } = input;
    const participant = await this.fenceFor(character);
    return this.settle(this.client.craftExecute({ ...rest, participant }));
  }

  /** `lootGrant`: system -> character; creates and assigns the instance. */
  async loot(
    input: Omit<LootGrantRequest, "participant"> & { character: number },
  ): Promise<AtomicOpResult> {
    const { character, ...rest } = input;
    const participant = await this.fenceFor(character);
    return this.settle(this.client.lootGrant({ ...rest, participant }));
  }

  /** `inventoryMutate`: move / merge / swap within one character's inventory. */
  async inventory(
    input: Omit<InventoryMutateRequest, "participant"> & { character: number },
  ): Promise<AtomicOpResult> {
    const { character, ...rest } = input;
    const participant = await this.fenceFor(character);
    return this.settle(this.client.inventoryMutate({ ...rest, participant }));
  }

  /** Record a settled outcome with the sync, then hand it to the caller. */
  private async settle(call: Promise<AtomicOpResult>): Promise<AtomicOpResult> {
    const result = await call;
    this.fences.applySettled(result);
    return result;
  }
}

// ---------------------------------------------------------------------------
// The local economy view: WalletSystem + ItemStore behind the sync's
// CharacterEconomyView, so world records and settled outcomes speak
// gold + bag inventory — the atomic operations' fields — in region
// terms (integer item ids, one unit per item instance, bag slots).
// ---------------------------------------------------------------------------

export interface LocalEconomyViewOptions {
  wallet: WalletSystem;
  store: ItemStore;
  /** Full durability for a def, for items the world creates locally. */
  durabilityOf: (def: number) => number;
  /** Tick stamped on wallet changes (the gateway re-stamps on send). */
  tick?: () => number;
}

export class LocalEconomyView implements CharacterEconomyView {
  private readonly wallet: WalletSystem;
  private readonly store: ItemStore;
  private readonly durabilityOf: (def: number) => number;
  private readonly tick: () => number;

  constructor(opts: LocalEconomyViewOptions) {
    this.wallet = opts.wallet;
    this.store = opts.store;
    this.durabilityOf = opts.durabilityOf;
    this.tick = opts.tick ?? (() => 0);
  }

  goldOf(characterId: number): number {
    return this.wallet.balanceOf(characterId);
  }

  inventoryOf(characterId: number): InventoryItem[] {
    const bag = this.store.bag(characterId);
    const out: InventoryItem[] = [];
    for (let slot = 0; slot < bag.length; slot++) {
      const id = bag[slot];
      if (id === 0) continue;
      const at = this.store.slot(id);
      if (at < 0) continue;
      out.push({
        instanceId: itemInstanceId(id),
        def: this.store.defs[at],
        slot,
        count: 1,
      });
    }
    return out;
  }

  reconcile(characterId: number, gold: number, inventory: InventoryItem[]): void {
    this.reconcileAll([{ characterId, gold, inventory }]);
  }

  reconcileAll(
    settled: Array<{ characterId: number; gold: number; inventory: InventoryItem[] }>,
  ): void {
    // The union of every participant's settled bag: an item moving
    // between participants is in exactly one of them, and must be
    // moved — never destroyed by another participant's pass.
    const desiredSomewhere = new Set<number>();
    for (const s of settled) {
      for (const item of s.inventory) {
        const id = parseItemInstanceId(item.instanceId);
        if (id !== null) desiredSomewhere.add(id);
      }
    }
    for (const s of settled) {
      this.wallet.reconcile(s.characterId, s.gold, this.tick());
      // Local bag items the settled outcome no longer places anywhere
      // (sold to a vendor, consumed by a craft, destroyed at the world
      // tier) leave existence; the item ledger records the destroy.
      for (const id of [...this.store.bag(s.characterId)]) {
        if (id !== 0 && !desiredSomewhere.has(id)) this.store.destroy(id);
      }
    }
    for (const s of settled) {
      for (const item of s.inventory) {
        const id = parseItemInstanceId(item.instanceId);
        if (id === null) continue; // a foreign instance: not a region item
        if (!this.store.exists(id)) {
          // The world created it (vendor buy, craft output, loot
          // grant): materialise it locally under its world identity.
          this.store.restore({
            id,
            kind: LedgerKind.Bag,
            def: item.def,
            owner: s.characterId,
            slot: item.slot,
            durability: this.durabilityOf(item.def),
            x: 0,
            z: 0,
          });
        } else {
          this.store.putInBagAt(s.characterId, id, item.slot);
        }
      }
    }
  }
}
