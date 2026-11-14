import { mulberry32 } from "./solver.js";

/**
 * Leaf outcome entry in a marble bag (`outcome` appears `count` times per cycle).
 */
export interface MarbleOutcomeEntry<T> {
  readonly outcome: T;
  readonly count: number;
}

/**
 * Nested bag entry (`bag` is drawn from `count` times per outer cycle).
 */
export interface MarbleNestedEntry<T> {
  readonly bag: MarbleBag<T>;
  readonly count: number;
}

/**
 * One entry in a MarbleBag definition: either a leaf outcome or a nested MarbleBag,
 * paired with its integer multiplicity per cycle.
 */
export type MarbleEntry<T> = MarbleOutcomeEntry<T> | MarbleNestedEntry<T>;

export interface MarbleBagOptions {
  /** Deterministic base seed (default `0x6d2b79f5`). */
  seed?: number;
  /** Automatically refill and reshuffle when the bag empties (default `true`). */
  autoReshuffle?: boolean;
}

export interface MarbleBagSnapshot {
  readonly version: 1;
  readonly seed: number;
  readonly cycle: number;
  readonly cursor: number;
  readonly children?: Readonly<Record<number, MarbleBagSnapshot>>;
}

/** Mix a 32-bit base seed with the cycle index so every cycle has an independent deterministic shuffle. */
function cycleSeed(baseSeed: number, cycle: number): number {
  let h = (baseSeed ^ Math.imul(cycle >>> 0, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function isNestedEntry<T>(entry: MarbleEntry<T>): entry is MarbleNestedEntry<T> {
  return typeof entry === "object" && entry !== null && "bag" in entry;
}

/**
 * Deterministic finite bag RNG (draw without replacement per cycle).
 *
 * Guarantees exact proportions over each full cycle, bounds worst-case dry/hot
 * streaks by construction, supports hierarchical nested bags, and exposes
 * serializable state (`snapshot()` / `restore()`) for authoritative persistence
 * and bit-identical replay.
 */
export class MarbleBag<T> {
  private readonly entries: readonly MarbleEntry<T>[];
  private readonly templateDeck: Int32Array;
  private deck: Int32Array;
  private baseSeed: number;
  private currentCycle = 1;
  private cursor = 0;
  readonly autoReshuffle: boolean;

  constructor(entries: readonly MarbleEntry<T>[], opts: MarbleBagOptions = {}) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error("MarbleBag requires at least one entry");
    }

    let total = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!Number.isInteger(e.count) || e.count < 0) {
        throw new Error(`MarbleBag entry ${i}: count must be a non-negative integer (got ${e.count})`);
      }
      if (isNestedEntry(e) && e.bag === this) {
        throw new Error(`MarbleBag entry ${i}: a bag cannot directly contain itself`);
      }
      total += e.count;
    }
    if (total <= 0) {
      throw new Error("MarbleBag total marble count must be at least 1");
    }

    this.entries = entries.map((e) => ({ ...e }));
    this.templateDeck = new Int32Array(total);
    let offset = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const c = this.entries[i].count;
      for (let k = 0; k < c; k++) {
        this.templateDeck[offset++] = i;
      }
    }

    this.deck = new Int32Array(total);
    this.baseSeed = (opts.seed ?? 0x6d2b79f5) >>> 0;
    this.autoReshuffle = opts.autoReshuffle ?? true;
    this.shuffleCurrentCycle();
  }

  /** Construct a MarbleBag cleanly from `[outcome, count]` pairs or an entries list. */
  static fromCounts<T>(
    items: readonly (readonly [outcome: T, count: number])[],
    opts: MarbleBagOptions = {},
  ): MarbleBag<T> {
    return new MarbleBag(
      items.map(([outcome, count]) => ({ outcome, count })),
      opts,
    );
  }

  /** Total marbles placed in the bag at the start of each cycle. */
  get capacity(): number {
    return this.templateDeck.length;
  }

  /** Number of undrawn marbles remaining in the current cycle. */
  get drawsRemaining(): number {
    return Math.max(0, this.deck.length - this.cursor);
  }

  /** 1-based shuffle cycle number. Increments on every reshuffle. */
  get cycle(): number {
    return this.currentCycle;
  }

  /** Unsigned 32-bit base seed driving this bag's permutations. */
  get seed(): number {
    return this.baseSeed;
  }

  /**
   * Draw one outcome from the bag without replacement.
   * When empty, reshuffles automatically unless `autoReshuffle` is `false` (in which case it throws).
   */
  draw(): T {
    const out = this.tryDraw();
    if (out === undefined && this.drawsRemaining === 0 && !this.autoReshuffle) {
      throw new Error("MarbleBag is empty (autoReshuffle is false)");
    }
    return out as T;
  }

  /**
   * Draw one outcome, returning `undefined` instead of throwing if empty and `autoReshuffle` is `false`.
   */
  tryDraw(): T | undefined {
    return this.drawWithVisited(new Set());
  }

  /** Draw `count` outcomes sequentially into an array. */
  drawMany(count: number): T[] {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`MarbleBag.drawMany: count must be a non-negative integer (got ${count})`);
    }
    const out: T[] = [];
    for (let i = 0; i < count; i++) out.push(this.draw());
    return out;
  }

  /**
   * Side-effect-free inspection of the next outcome to be drawn in the current cycle.
   * Returns `undefined` if the current cycle is exhausted (before reshuffle).
   */
  peek(): T | undefined {
    return this.peekWithVisited(new Set());
  }

  /**
   * Refill and reshuffle the bag for the next cycle (optionally updating the base seed).
   */
  reshuffle(nextSeed?: number): void {
    if (nextSeed !== undefined) {
      this.baseSeed = nextSeed >>> 0;
      this.currentCycle = 1;
    } else {
      this.currentCycle++;
    }
    this.cursor = 0;
    this.shuffleCurrentCycle();
  }

  /**
   * Serialize minimal authoritative state needed to persist and restore this bag
   * (including any nested child bags).
   */
  snapshot(): MarbleBagSnapshot {
    const children: Record<number, MarbleBagSnapshot> = {};
    let hasChildren = false;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (isNestedEntry(entry)) {
        children[i] = entry.bag.snapshot();
        hasChildren = true;
      }
    }
    return {
      version: 1,
      seed: this.baseSeed,
      cycle: this.currentCycle,
      cursor: this.cursor,
      ...(hasChildren ? { children } : {}),
    };
  }

  /**
   * Restore previously snapshotted state cleanly, recomputing the exact permutation
   * from `(seed, cycle)` and advancing cursor to match.
   */
  restore(snapshot: MarbleBagSnapshot): void {
    if (snapshot.version !== 1) {
      throw new Error(`MarbleBag.restore: unsupported snapshot version ${String(snapshot.version)}`);
    }
    if (!Number.isInteger(snapshot.cycle) || snapshot.cycle < 1) {
      throw new Error(`MarbleBag.restore: invalid cycle ${snapshot.cycle}`);
    }
    if (!Number.isInteger(snapshot.cursor) || snapshot.cursor < 0 || snapshot.cursor > this.deck.length) {
      throw new Error(`MarbleBag.restore: invalid cursor ${snapshot.cursor}`);
    }
    this.baseSeed = snapshot.seed >>> 0;
    this.currentCycle = snapshot.cycle;
    this.cursor = snapshot.cursor;
    this.shuffleCurrentCycle();
    if (snapshot.children) {
      for (let i = 0; i < this.entries.length; i++) {
        const entry = this.entries[i];
        const childSnap = snapshot.children[i];
        if (isNestedEntry(entry) && childSnap) {
          entry.bag.restore(childSnap);
        }
      }
    }
  }

  private drawWithVisited(visited: Set<MarbleBag<unknown>>): T | undefined {
    if (visited.has(this)) {
      throw new Error("MarbleBag cycle detected in nested bag graph");
    }
    if (this.cursor >= this.deck.length) {
      if (!this.autoReshuffle) return undefined;
      this.reshuffle();
    }
    const entry = this.entries[this.deck[this.cursor++]];
    if (isNestedEntry(entry)) {
      visited.add(this);
      try {
        return entry.bag.drawWithVisited(visited);
      } finally {
        visited.delete(this);
      }
    }
    return entry.outcome;
  }

  private peekWithVisited(visited: Set<MarbleBag<unknown>>): T | undefined {
    if (visited.has(this)) {
      throw new Error("MarbleBag cycle detected in nested bag graph");
    }
    if (this.cursor >= this.deck.length) return undefined;
    const entry = this.entries[this.deck[this.cursor]];
    if (isNestedEntry(entry)) {
      visited.add(this);
      try {
        return entry.bag.peekWithVisited(visited);
      } finally {
        visited.delete(this);
      }
    }
    return entry.outcome;
  }

  private shuffleCurrentCycle(): void {
    this.deck.set(this.templateDeck);
    const rng = mulberry32(cycleSeed(this.baseSeed, this.currentCycle));
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = this.deck[i];
      this.deck[i] = this.deck[j];
      this.deck[j] = tmp;
    }
  }
}
