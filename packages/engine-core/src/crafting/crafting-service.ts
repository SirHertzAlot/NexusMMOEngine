/**
 * CraftingService — the crafting EXECUTION step (slice A2).
 *
 * Recipe derivation lives in @mmo-engine/crafting (recipes.ts: what a
 * craft consumes and produces, as data). This service is the moment
 * of execution the atomic-operations spec names: consume the inputs
 * and the gold fee, produce the outputs, all-or-nothing — value is
 * neither created nor destroyed by a half-finished craft.
 *
 * - Standalone (no executor wired): the execution is local, exactly
 *   the validate-everything-then-move-everything shape the region
 *   economy systems use.
 * - Fleet mode: the execution step routes through the world-tier
 *   `craftExecute` operation (one WorldStore transaction). The
 *   region validates the craft first (inputs present, fee payable,
 *   bag room for the outputs); on success the settled outcome is
 *   applied to the local caches by the coordinator's reconciliation
 *   (inputs destroyed, outputs materialised, gold adopted). Fail
 *   closed: a typed rejection or a world outage crafts nothing —
 *   pre-allocated output items are destroyed and the refusal
 *   surfaces as the result's error. No local fallback, ever.
 */

import type { WalletSystem } from "../economy/wallet.js";
import type { ItemService } from "../items/item-service.js";
import { itemInstanceId } from "../world/atomic-ops.js";

/**
 * The fleet-mode craft executor: routes one craft's execution through
 * the world tier. Returns the settled outcome as a value; an outage
 * throws. Supplied by the server's fleet wiring (WorldAtomicOps).
 */
export interface AtomicCraftExecutor {
  craft(
    character: number,
    consumes: Array<{ instanceId: string; count: number }>,
    goldFee: number,
    outputs: Array<{ instanceId: string; def: number }>,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
}

export interface CraftRequest {
  /** Bag item ids consumed by the craft (each once — region items are single-unit). */
  consumes: number[];
  /** Gold fee charged by the craft (a declared sink); 0: none. */
  goldFee: number;
  /** Item defs produced by the craft. */
  outputs: number[];
}

export type CraftResult =
  | { ok: true; message: string; produced: number[] }
  | { ok: false; error: string };

export interface CraftingServiceOptions {
  wallet: WalletSystem;
  items: ItemService;
  /** Fleet mode: the world-tier craft executor. Absent: local execution. */
  atomicCraft?: AtomicCraftExecutor;
}

export class CraftingService {
  private readonly wallet: WalletSystem;
  private readonly items: ItemService;
  private readonly atomicCraft: AtomicCraftExecutor | null;

  constructor(opts: CraftingServiceOptions) {
    this.wallet = opts.wallet;
    this.items = opts.items;
    this.atomicCraft = opts.atomicCraft ?? null;
  }

  /**
   * Execute one craft for `character`. Async because the fleet path
   * awaits the world; the standalone path resolves immediately with
   * the local outcome. Every failure — region-side validation, a
   * world rejection, an outage — returns { ok: false } having moved
   * nothing.
   */
  async craft(character: number, req: CraftRequest, tick: number): Promise<CraftResult> {
    const store = this.items.store;
    // Region-side validation (both modes): every input is in the bag,
    // the fee is payable, and the bag has room for the outputs once
    // the inputs leave it.
    for (const item of req.consumes) {
      if (!store.inBagOf(character, item)) return { ok: false, error: "you don't have the materials" };
    }
    if (!Number.isInteger(req.goldFee) || req.goldFee < 0) {
      return { ok: false, error: "bad craft fee" };
    }
    if (this.wallet.balanceOf(character) < req.goldFee) {
      return { ok: false, error: "not enough gold" };
    }
    for (const def of req.outputs) {
      if (def < 0 || def >= this.items.defs.count) return { ok: false, error: "no such item" };
    }
    const roomAfter = store.emptySlots(character) + new Set(req.consumes).size;
    if (req.outputs.length > roomAfter) return { ok: false, error: "your bag is full" };

    if (!this.atomicCraft) {
      // Standalone: validate-everything-then-move-everything, locally.
      if (req.goldFee > 0) this.wallet.spend(character, req.goldFee, tick);
      for (const item of req.consumes) store.destroy(item);
      const produced: number[] = [];
      for (const def of req.outputs) {
        const item = store.create(def, this.items.defs.durability[def]);
        store.putInBag(character, item);
        produced.push(item);
      }
      return { ok: true, message: "crafted", produced };
    }

    // Fleet mode: allocate the outputs' identities locally (Free
    // state, in no bag) so the world execution and the local items
    // share instance ids, then route the execution step through the
    // world tier. On any failure the allocations are destroyed.
    const allocated: number[] = [];
    try {
      for (const def of req.outputs) {
        allocated.push(store.create(def, this.items.defs.durability[def]));
      }
      const settled = await this.atomicCraft.craft(
        character,
        req.consumes.map((item) => ({ instanceId: itemInstanceId(item), count: 1 })),
        req.goldFee,
        req.outputs.map((def, i) => ({ instanceId: itemInstanceId(allocated[i]), def })),
      );
      if (!settled.ok) {
        for (const item of allocated) store.destroy(item);
        return { ok: false, error: settled.message };
      }
    } catch (err) {
      for (const item of allocated) store.destroy(item);
      return {
        ok: false,
        error: `craft refused: the world tier is unreachable (${(err as Error).message})`,
      };
    }
    // The settled outcome reconciled inputs, outputs and gold into
    // the local caches; confirm the outputs landed before reporting.
    for (const item of allocated) {
      if (!store.inBagOf(character, item)) {
        return { ok: false, error: "craft refused: the settled outcome did not land" };
      }
    }
    return { ok: true, message: "crafted", produced: allocated };
  }
}
