/**
 * Wave Function Collapse over any graph.
 *
 * A problem is a set of **slots** (graph nodes), each of which must become
 * one of the **options** (a tile, a prop, an affix, a quest step, …), with
 *
 *  - domains and weights per slot: which options it may take, and how
 *    likely each is there (a biome's suitability, a room's depth);
 *  - **edges** between slots, each under a named **rule**: which option
 *    pairs may sit across it ("fire" never beside "ice", "coast" between
 *    "land" and "sea"). Edges with no rule just make slots neighbours;
 *  - **needs**: an option that requires some neighbours to be of a kind
 *    (a tent needs a fire within reach);
 *  - **counts**: how many slots overall may (or must) take a group of
 *    options (exactly 10% legendary, at most one relic);
 *  - **budgets**: a cost per option and a total to stay within (a rank's
 *    power budget);
 *  - **pins**: slots already decided (a neighbouring chunk's border, an
 *    editor override).
 *
 * The solver repeatedly collapses the undecided slot of lowest entropy
 * (Shannon entropy of its remaining weights) to one option drawn by
 * weight, then propagates: edge rules to arc consistency, needs, counts
 * and budgets to their bounds. A contradiction undoes the last decision
 * (a trail of removals, so undo costs only what it undoes) and bans that
 * choice; after too many backtracks it restarts from a derived seed.
 *
 * Deterministic: the same problem and seed always give the same solution.
 * Bake-time code: nothing here runs on the tick path.
 */

export interface WfcOption {
  id: string;
  /** Relative likelihood (default 1). 0: never chosen. */
  weight?: number;
  tags?: readonly string[];
}

export interface WfcEdge {
  a: number;
  b: number;
  /** A rule name from `rules` (undefined: neighbours only, for needs). */
  rule?: string;
}

/**
 * Edges as parallel arrays (for large graphs: no object per edge). `rule`
 * indexes the problem's rule names in insertion order; -1: no rule.
 */
export interface WfcEdgeArrays {
  a: Int32Array;
  b: Int32Array;
  rule: Int32Array;
}

/** May option `x` at an edge's `a` end sit with option `y` at its `b` end? */
export type WfcRule = (x: WfcOption, y: WfcOption, xi: number, yi: number) => boolean;

export interface WfcNeed {
  /** The option that has the need. */
  option: number;
  /** Options that satisfy it. */
  from: readonly number[];
  /** Neighbours needed (default 1). */
  count?: number;
  /** Only neighbours across edges under this rule, or these rules (default: any edge). */
  rule?: string | readonly string[];
}

export interface WfcCount {
  options: readonly number[];
  min?: number;
  max?: number;
  /** Only these slots count toward it (default: all). */
  slots?: readonly number[];
}

export interface WfcBudget {
  /** Cost per option (length = options). */
  cost: readonly number[];
  min?: number;
  max?: number;
  /** Only these slots count toward it (default: all). */
  slots?: readonly number[];
}

export interface WfcProblem {
  options: readonly WfcOption[];
  slots: number;
  /** Allowed options per slot (null / missing: all). */
  domains?: readonly (readonly number[] | null | undefined)[];
  /** Per-slot weight multipliers, slots × options (0 removes the option there). */
  weights?: Float64Array;
  edges?: readonly WfcEdge[] | WfcEdgeArrays;
  rules?: Record<string, WfcRule>;
  needs?: readonly WfcNeed[];
  counts?: readonly WfcCount[];
  budgets?: readonly WfcBudget[];
  /** slot -> option. */
  pins?: ReadonlyMap<number, number> | Readonly<Record<number, number>>;
  /**
   * Slots solved elsewhere and brought in as context (a neighbouring
   * tile's border): their own needs aren't checked, since what meets
   * them may lie outside this problem. Pin or restrict them as well.
   */
  settled?: readonly number[];
  /**
   * A propagator run whenever a slot is decided (down to one option):
   * returns [slot, option, slot, option, …] to remove. For sparse,
   * long-range rules that would need too many edges, like "no two camps
   * within 45 m" (see pointsProblem). Removals go on the same trail, so
   * backtracking undoes them.
   */
  onDecided?: (slot: number, option: number) => ArrayLike<number> | null;
}

export interface WfcSettings {
  seed: number;
  /** Backtracks before restarting from a new seed (default 2000). */
  maxBacktracks?: number;
  /** Restarts before giving up (default 8). */
  maxRestarts?: number;
}

export interface WfcSolution {
  /** Option index per slot. */
  assignment: Int32Array;
  /** Option id per slot. */
  ids: string[];
  stats: { decisions: number; backtracks: number; restarts: number; seed: number };
}

export class WfcError extends Error {
  constructor(message: string, readonly slot: number | null = null) {
    super(message);
    this.name = "WfcError";
  }
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A well-mixed u32 from a seed and an index. */
export function deriveSeed(seed: number, index: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The problem compiled to flat arrays, shared by every restart. */
interface Compiled {
  N: number;
  K: number;
  /** Effective weight per slot × option (0: not allowed there). */
  w: Float64Array;
  wlogw: Float64Array;
  /** Rules; index R stands for "no rule". */
  R: number;
  /**
   * CSR adjacency, each slot's entries grouped by rule: slot s's entries
   * under rule r are adjNb[ruleOff[s*(R+2)+r] .. ruleOff[s*(R+2)+r+1]).
   */
  ruleOff: Int32Array;
  adjNb: Int32Array;
  /** Rule index per entry (R: none). */
  adjRule: Int32Array;
  /** Compatibility matrix per entry, oriented self → neighbour (null: no rule). */
  adjMat: (Uint8Array | null)[];
  /**
   * Per entry: the most options of this slot a neighbour's option can be
   * incompatible with. While the slot keeps more options than that, every
   * neighbour option still has a partner and the edge needn't be revised.
   */
  adjSkip: Int32Array;
  /** Rule indices a need reads (null: every edge). */
  needsByOption: { from: Uint8Array; count: number; rules: number[] | null }[][];
  /** Rule indices across which a change can affect a need (all: some need reads every edge). */
  needTrigger: Uint8Array;
  counts: { member: Uint8Array; min: number; max: number; inSlot: Uint8Array | null }[];
  /** 1: a settled slot (needs not checked). */
  settled: Uint8Array;
  budgets: { cost: Float64Array; min: number; max: number; inSlot: Uint8Array | null }[];
  pins: [number, number][];
  onDecided: ((slot: number, option: number) => ArrayLike<number> | null) | null;
}

function compile(p: WfcProblem): Compiled {
  const N = p.slots, K = p.options.length;
  if (!Number.isInteger(N) || N < 0) throw new WfcError(`slots must be a whole number (got ${N})`);
  if (K === 0) throw new WfcError("no options");
  const w = new Float64Array(N * K);
  for (let s = 0; s < N; s++) {
    const dom = p.domains?.[s];
    for (let x = 0; x < K; x++) {
      const base = p.options[x].weight ?? 1;
      if (!(base >= 0)) throw new WfcError(`option ${p.options[x].id}: weight must be >= 0`);
      w[s * K + x] = base * (p.weights ? p.weights[s * K + x] : 1);
    }
    if (dom) {
      const keep = new Uint8Array(K);
      for (const x of dom) {
        if (!(x >= 0 && x < K)) throw new WfcError(`slot ${s}: no option ${x}`, s);
        keep[x] = 1;
      }
      for (let x = 0; x < K; x++) if (!keep[x]) w[s * K + x] = 0;
    }
  }
  const wlogw = new Float64Array(N * K);
  for (let i = 0; i < w.length; i++) wlogw[i] = w[i] > 0 ? w[i] * Math.log(w[i]) : 0;

  const ruleNames = Object.keys(p.rules ?? {});
  const ruleId = new Map(ruleNames.map((n, i) => [n, i]));
  const mats: Uint8Array[] = [];
  const matsT: Uint8Array[] = [];
  for (const name of ruleNames) {
    const rule = (p.rules as Record<string, WfcRule>)[name];
    const m = new Uint8Array(K * K), t = new Uint8Array(K * K);
    for (let x = 0; x < K; x++)
      for (let y = 0; y < K; y++)
        if (rule(p.options[x], p.options[y], x, y)) {
          m[x * K + y] = 1;
          t[y * K + x] = 1;
        }
    mats.push(m);
    matsT.push(t);
  }
  // The most zeros in any column (oriented matrices): see Compiled.adjSkip.
  const maxZeros = (m: Uint8Array): number => {
    let most = 0;
    for (let y = 0; y < K; y++) {
      let z = 0;
      for (let x = 0; x < K; x++) if (!m[x * K + y]) z++;
      most = Math.max(most, z);
    }
    return most;
  };
  const skipM = mats.map(maxZeros), skipT = matsT.map(maxZeros);
  const R = ruleNames.length;
  const S = R + 2;
  // Edges as arrays, rule indices (R: none).
  let ea: Int32Array, eb: Int32Array, er: Int32Array;
  const given = p.edges ?? [];
  if (Array.isArray(given)) {
    const list = given as readonly WfcEdge[];
    ea = new Int32Array(list.length);
    eb = new Int32Array(list.length);
    er = new Int32Array(list.length);
    list.forEach((e, i) => {
      if (e.rule !== undefined && !ruleId.has(e.rule)) throw new WfcError(`edge ${e.a}-${e.b}: no rule "${e.rule}"`);
      ea[i] = e.a;
      eb[i] = e.b;
      er[i] = e.rule === undefined ? R : (ruleId.get(e.rule) as number);
    });
  } else {
    const arrays = given as WfcEdgeArrays;
    if (arrays.b.length !== arrays.a.length || arrays.rule.length !== arrays.a.length) throw new WfcError("edge arrays differ in length");
    ea = arrays.a;
    eb = arrays.b;
    er = new Int32Array(arrays.rule.length);
    for (let i = 0; i < er.length; i++) {
      const r = arrays.rule[i];
      if (!(r >= -1 && r < R)) throw new WfcError(`edge ${ea[i]}-${eb[i]}: no rule ${r}`);
      er[i] = r < 0 ? R : r;
    }
  }
  const E = ea.length;
  const ruleOff = new Int32Array(N * S + 1);
  for (let i = 0; i < E; i++) {
    const a = ea[i], b = eb[i];
    if (!(a >= 0 && a < N && b >= 0 && b < N) || a === b) throw new WfcError(`edge ${a}-${b}: not two different slots`);
    ruleOff[a * S + er[i] + 1]++;
    ruleOff[b * S + er[i] + 1]++;
  }
  // Counts to offsets: slot s's block starts where slot s-1's ends.
  let run = 0;
  for (let s = 0; s < N; s++) {
    ruleOff[s * S] = run;
    for (let r = 0; r <= R; r++) {
      run += ruleOff[s * S + r + 1];
      ruleOff[s * S + r + 1] = run;
    }
  }
  const fill = new Int32Array(N * S);
  for (let s = 0; s < N; s++) for (let r = 0; r <= R; r++) fill[s * S + r] = ruleOff[s * S + r];
  const adjNb = new Int32Array(run);
  const adjRule = new Int32Array(run);
  const adjSkip = new Int32Array(run);
  const adjMat: (Uint8Array | null)[] = new Array(run);
  for (let k = 0; k < E; k++) {
    const r = er[k], a = ea[k], b = eb[k];
    let i = fill[a * S + r]++;
    adjNb[i] = b; adjRule[i] = r; adjMat[i] = r === R ? null : mats[r]; adjSkip[i] = r === R ? -1 : skipM[r];
    i = fill[b * S + r]++;
    adjNb[i] = a; adjRule[i] = r; adjMat[i] = r === R ? null : matsT[r]; adjSkip[i] = r === R ? -1 : skipT[r];
  }

  const needsByOption: Compiled["needsByOption"] = Array.from({ length: K }, () => []);
  const needTrigger = new Uint8Array(R + 1);
  for (const n of p.needs ?? []) {
    if (!(n.option >= 0 && n.option < K)) throw new WfcError(`need: no option ${n.option}`);
    const names = n.rule === undefined ? null : typeof n.rule === "string" ? [n.rule] : n.rule;
    for (const name of names ?? []) if (!ruleId.has(name)) throw new WfcError(`need: no rule "${name}"`);
    const rules = names ? names.map((name) => ruleId.get(name) as number) : null;
    for (let r = 0; r <= R; r++) if (!rules || rules.includes(r)) needTrigger[r] = 1;
    const from = new Uint8Array(K);
    for (const y of n.from) from[y] = 1;
    needsByOption[n.option].push({ from, count: n.count ?? 1, rules });
  }
  const slotSet = (list: readonly number[] | undefined, what: string): Uint8Array | null => {
    if (!list) return null;
    const set = new Uint8Array(N);
    for (const s of list) {
      if (!(s >= 0 && s < N)) throw new WfcError(`${what}: no slot ${s}`);
      set[s] = 1;
    }
    return set;
  };
  const counts = (p.counts ?? []).map((c) => {
    const member = new Uint8Array(K);
    for (const x of c.options) member[x] = 1;
    return { member, min: c.min ?? 0, max: c.max ?? Infinity, inSlot: slotSet(c.slots, "count") };
  });
  const settled = slotSet(p.settled, "settled") ?? new Uint8Array(N);
  const budgets = (p.budgets ?? []).map((b) => {
    if (b.cost.length !== K) throw new WfcError(`budget: ${b.cost.length} costs for ${K} options`);
    const inSlot = slotSet(b.slots, "budget");
    return { cost: Float64Array.from(b.cost), min: b.min ?? -Infinity, max: b.max ?? Infinity, inSlot };
  });
  const pinEntries: [number, number][] =
    p.pins instanceof Map ? [...p.pins.entries()] : Object.entries(p.pins ?? {}).map(([s, x]) => [Number(s), x as number]);
  for (const [s, x] of pinEntries) if (!(s >= 0 && s < N && x >= 0 && x < K)) throw new WfcError(`pin ${s} -> ${x}: out of range`);
  return { N, K, w, wlogw, R, ruleOff, adjNb, adjRule, adjMat, adjSkip, needsByOption, needTrigger, counts, budgets, pins: pinEntries, settled, onDecided: p.onDecided ?? null };
}

/** A binary min-heap of (key, slot), ties broken by slot. Entries may be stale: the reader checks. */
class Heap {
  keys = new Float64Array(256);
  vals = new Int32Array(256);
  length = 0;

  push(k: number, v: number): void {
    if (this.length === this.keys.length) {
      const k2 = new Float64Array(this.keys.length * 2), v2 = new Int32Array(this.keys.length * 2);
      k2.set(this.keys);
      v2.set(this.vals);
      this.keys = k2;
      this.vals = v2;
    }
    let i = this.length++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(k, v, this.keys[p], this.vals[p])) {
        this.keys[i] = this.keys[p];
        this.vals[i] = this.vals[p];
        i = p;
      } else break;
    }
    this.keys[i] = k;
    this.vals[i] = v;
  }

  /** Remove the top; its key and slot are left in `topKey` / `topVal`. */
  topKey = 0;
  topVal = -1;
  pop(): boolean {
    if (this.length === 0) return false;
    this.topKey = this.keys[0];
    this.topVal = this.vals[0];
    const k = this.keys[--this.length], v = this.vals[this.length];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i, mk = k, mv = v;
      if (l < this.length && this.less(this.keys[l], this.vals[l], mk, mv)) { m = l; mk = this.keys[l]; mv = this.vals[l]; }
      if (r < this.length && this.less(this.keys[r], this.vals[r], mk, mv)) { m = r; }
      if (m === i) break;
      this.keys[i] = this.keys[m];
      this.vals[i] = this.vals[m];
      i = m;
    }
    if (this.length > 0) {
      this.keys[i] = k;
      this.vals[i] = v;
    }
    return true;
  }

  private less(ka: number, va: number, kb: number, vb: number): boolean {
    return ka < kb || (ka === kb && va < vb);
  }
}

/** One solving attempt's state. */
class Search {
  readonly dom: Uint8Array;
  readonly size: Int32Array;
  readonly sumW: Float64Array;
  readonly sumWL: Float64Array;
  readonly noise: Float64Array;
  private trail: Int32Array = new Int32Array(1024);
  private trailLen = 0;
  private readonly queue: Int32Array;
  private readonly queued: Uint8Array;
  private qHead = 0;
  private qLen = 0;
  /** A removal happened since the last global pass (true at the start: counts and budgets are checked at least once). */
  private dirty = true;
  /** Undecided slots by entropy (lazily: stale entries are skipped). */
  private readonly heap = new Heap();
  /** Slots decided since the last onDecided pass. */
  private decidedQueue: number[] = [];
  contradiction = -1;

  constructor(private readonly c: Compiled, readonly rng: () => number) {
    const { N, K, w, wlogw } = c;
    this.dom = new Uint8Array(N * K);
    this.size = new Int32Array(N);
    this.sumW = new Float64Array(N);
    this.sumWL = new Float64Array(N);
    this.noise = new Float64Array(N);
    this.queue = new Int32Array(N);
    this.queued = new Uint8Array(N);
    for (let s = 0; s < N; s++) {
      for (let x = 0; x < K; x++) {
        const i = s * K + x;
        if (w[i] > 0) {
          this.dom[i] = 1;
          this.size[s]++;
          this.sumW[s] += w[i];
          this.sumWL[s] += wlogw[i];
        }
      }
      this.noise[s] = rng() * 1e-6;
      if (this.size[s] === 0) this.contradiction = s;
      if (this.size[s] > 1) this.heap.push(this.entropy(s), s);
      else if (this.size[s] === 1 && c.onDecided) this.decidedQueue.push(s);
    }
  }

  private entropy(s: number): number {
    const S = this.sumW[s];
    return Math.log(S) - this.sumWL[s] / S + this.noise[s];
  }

  get mark(): number {
    return this.trailLen;
  }

  /** Remove option x from slot s (recorded for undo). False on a contradiction. */
  remove(s: number, x: number): boolean {
    const K = this.c.K, i = s * K + x;
    if (!this.dom[i]) return true;
    this.dom[i] = 0;
    this.size[s]--;
    this.sumW[s] -= this.c.w[i];
    this.sumWL[s] -= this.c.wlogw[i];
    if (this.trailLen === this.trail.length) {
      const t = new Int32Array(this.trail.length * 2);
      t.set(this.trail);
      this.trail = t;
    }
    this.trail[this.trailLen++] = i;
    this.dirty = true;
    if (this.size[s] === 0) {
      this.contradiction = s;
      return false;
    }
    if (this.size[s] > 1) this.heap.push(this.entropy(s), s);
    else if (this.c.onDecided) this.decidedQueue.push(s);
    if (!this.queued[s]) {
      this.queued[s] = 1;
      this.queue[(this.qHead + this.qLen++) % this.c.N] = s;
    }
    return true;
  }

  undo(to: number): void {
    const K = this.c.K;
    const touched: number[] = [];
    while (this.trailLen > to) {
      const i = this.trail[--this.trailLen];
      const s = (i / K) | 0;
      this.dom[i] = 1;
      this.size[s]++;
      this.sumW[s] += this.c.w[i];
      this.sumWL[s] += this.c.wlogw[i];
      touched.push(s);
    }
    for (const s of touched) if (this.size[s] > 1) this.heap.push(this.entropy(s), s);
    while (this.qLen > 0) {
      this.queued[this.queue[this.qHead]] = 0;
      this.qHead = (this.qHead + 1) % this.c.N;
      this.qLen--;
    }
    this.decidedQueue = [];
    this.contradiction = -1;
  }

  /** Every slot's neighbours and needs rechecked (the start, after pins). */
  enqueueAll(): void {
    for (let s = 0; s < this.c.N; s++)
      if (!this.queued[s]) {
        this.queued[s] = 1;
        this.queue[(this.qHead + this.qLen++) % this.c.N] = s;
      }
  }

  /** Every slot's needs, once at the start (a slot with no neighbours is never reached through one). */
  checkAllNeeds(): boolean {
    for (let s = 0; s < this.c.N; s++) if (!this.checkNeeds(s)) return false;
    return true;
  }

  /** Propagate to a fixed point. False on a contradiction. */
  propagate(): boolean {
    for (;;) {
      if (!this.propagateLocal()) return false;
      if (this.decidedQueue.length > 0) {
        if (!this.runDecided()) return false;
        continue;
      }
      if (!this.dirty || (this.c.counts.length === 0 && this.c.budgets.length === 0)) return true;
      this.dirty = false;
      if (!this.globals()) return false;
      if (this.qLen === 0 && !this.dirty) return true;
    }
  }

  /** The onDecided propagator on every slot decided since the last pass. */
  private runDecided(): boolean {
    const { K } = this.c;
    const hook = this.c.onDecided as NonNullable<Compiled["onDecided"]>;
    while (this.decidedQueue.length > 0) {
      const s = this.decidedQueue.shift() as number;
      if (this.size[s] !== 1) continue;
      let x = 0;
      while (!this.dom[s * K + x]) x++;
      const out = hook(s, x);
      if (!out) continue;
      for (let i = 0; i + 1 < out.length; i += 2) if (!this.remove(out[i], out[i + 1])) return false;
    }
    return true;
  }

  private propagateLocal(): boolean {
    const { K, R, ruleOff, adjNb, adjMat, adjSkip, adjRule, needTrigger } = this.c;
    const dom = this.dom;
    const S = R + 2;
    while (this.qLen > 0) {
      const s = this.queue[this.qHead];
      this.qHead = (this.qHead + 1) % this.c.N;
      this.qLen--;
      this.queued[s] = 0;
      for (let e = ruleOff[s * S]; e < ruleOff[s * S + R + 1]; e++) {
        const t = adjNb[e];
        const m = adjMat[e];
        // Edge rule: every option left at t needs a partner left at s
        // (certain while s keeps more options than any of t's can refuse).
        if (m && this.size[s] <= adjSkip[e]) {
          for (let y = 0; y < K; y++) {
            if (!dom[t * K + y]) continue;
            let ok = false;
            for (let x = 0; x < K; x++)
              if (dom[s * K + x] && m[x * K + y]) {
                ok = true;
                break;
              }
            if (!ok && !this.remove(t, y)) return false;
          }
        }
        // Needs: s changed, so t's needy options may have lost their support.
        if (needTrigger[adjRule[e]] && !this.checkNeeds(t)) return false;
      }
    }
    return true;
  }

  /**
   * Needs at slot t: an option whose neighbours can no longer supply what
   * it needs is removed; and once t is decided, if only just enough
   * neighbours can still supply it, they must.
   */
  /** Slot t's entries a need reads: [start, end) ranges. */
  private needRanges(t: number, rules: number[] | null): number[] {
    const { R, ruleOff } = this.c;
    const S = R + 2;
    if (!rules) return [ruleOff[t * S], ruleOff[t * S + R + 1]];
    const out: number[] = [];
    for (const r of rules) out.push(ruleOff[t * S + r], ruleOff[t * S + r + 1]);
    return out;
  }

  private checkNeeds(t: number): boolean {
    const { K, adjNb, needsByOption } = this.c;
    const dom = this.dom;
    if (this.c.settled[t]) return true;
    const decided = this.size[t] === 1;
    for (let x = 0; x < K; x++) {
      if (!dom[t * K + x]) continue;
      for (const n of needsByOption[x]) {
        const ranges = this.needRanges(t, n.rules);
        let have = 0;
        for (let k = 0; k < ranges.length && have <= n.count; k += 2)
          for (let e = ranges[k]; e < ranges[k + 1]; e++) {
            const u = adjNb[e];
            for (let y = 0; y < K; y++)
              if (n.from[y] && dom[u * K + y]) {
                have++;
                break;
              }
            if (have > n.count) break;
          }
        if (have < n.count) {
          if (!this.remove(t, x)) return false;
          break;
        }
        if (decided && have === n.count) {
          // Every remaining supporter must supply it.
          for (let k = 0; k < ranges.length; k += 2)
          for (let e = ranges[k]; e < ranges[k + 1]; e++) {
            const u = adjNb[e];
            let can = false;
            for (let y = 0; y < K; y++) if (n.from[y] && dom[u * K + y]) can = true;
            if (!can) continue;
            for (let y = 0; y < K; y++) if (!n.from[y] && dom[u * K + y] && !this.remove(u, y)) return false;
          }
        }
      }
    }
    return true;
  }

  /** Counts and budgets to their bounds. */
  private globals(): boolean {
    const { N, K, counts, budgets } = this.c;
    const dom = this.dom, size = this.size;
    for (const g of counts) {
      let fixed = 0, possible = 0;
      for (let s = 0; s < N; s++) {
        if (g.inSlot && !g.inSlot[s]) continue;
        let any = false, all = true;
        for (let x = 0; x < K; x++) {
          if (!dom[s * K + x]) continue;
          if (g.member[x]) any = true;
          else all = false;
        }
        if (any) possible++;
        if (any && all) fixed++;
      }
      if (fixed > g.max || possible < g.min) {
        this.contradiction = 0;
        return false;
      }
      if (fixed === g.max && possible > fixed) {
        // Full: nothing else may take the group.
        for (let s = 0; s < N; s++) {
          if (g.inSlot && !g.inSlot[s]) continue;
          let all = true;
          for (let x = 0; x < K; x++) if (dom[s * K + x] && !g.member[x]) all = false;
          if (all) continue;
          for (let x = 0; x < K; x++) if (g.member[x] && !this.remove(s, x)) return false;
        }
      } else if (possible === g.min && fixed < possible) {
        // Exactly enough candidates left: every one of them must take the group.
        for (let s = 0; s < N; s++) {
          if (g.inSlot && !g.inSlot[s]) continue;
          let any = false;
          for (let x = 0; x < K; x++) if (dom[s * K + x] && g.member[x]) any = true;
          if (!any) continue;
          for (let x = 0; x < K; x++) if (!g.member[x] && !this.remove(s, x)) return false;
        }
      }
    }
    for (const b of budgets) {
      const lo = new Float64Array(N), hi = new Float64Array(N);
      let sumLo = 0, sumHi = 0;
      for (let s = 0; s < N; s++) {
        if (b.inSlot && !b.inSlot[s]) continue;
        let l = Infinity, h = -Infinity;
        for (let x = 0; x < K; x++)
          if (dom[s * K + x]) {
            l = Math.min(l, b.cost[x]);
            h = Math.max(h, b.cost[x]);
          }
        lo[s] = l; hi[s] = h;
        sumLo += l; sumHi += h;
      }
      if (sumLo > b.max + 1e-9 || sumHi < b.min - 1e-9) {
        this.contradiction = 0;
        return false;
      }
      for (let s = 0; s < N; s++) {
        if ((b.inSlot && !b.inSlot[s]) || size[s] === 1) continue;
        for (let x = 0; x < K; x++) {
          if (!dom[s * K + x]) continue;
          const c = b.cost[x];
          if (sumLo - lo[s] + c > b.max + 1e-9 || sumHi - hi[s] + c < b.min - 1e-9) {
            if (!this.remove(s, x)) return false;
          }
        }
      }
    }
    return true;
  }

  /** The undecided slot of lowest entropy (-1: all decided). */
  pickSlot(): number {
    const heap = this.heap;
    while (heap.pop()) {
      const s = heap.topVal;
      // Skip stale entries: decided since, or its entropy has changed.
      if (this.size[s] > 1 && heap.topKey === this.entropy(s)) return s;
    }
    return -1;
  }

  /**
   * The supporters a decision brings with it: choosing option x at s,
   * whose needs aren't yet met by decided neighbours, also chooses
   * neighbours to meet them (drawn by weight), so a tent is placed with
   * its fire rather than hoping for one later. Returns [slot, option]
   * pairs to decide alongside.
   */
  supporters(s: number, x: number): [number, number][] {
    const { K, w, adjNb, needsByOption } = this.c;
    const dom = this.dom;
    const out: [number, number][] = [];
    const taken = new Set<number>();
    for (const n of needsByOption[x]) {
      let met = 0;
      const open: number[] = [];
      const ranges = this.needRanges(s, n.rules);
      for (let k = 0; k < ranges.length; k += 2)
      for (let e = ranges[k]; e < ranges[k + 1]; e++) {
        const u = adjNb[e];
        let can = false, only = true;
        for (let y = 0; y < K; y++) {
          if (!dom[u * K + y]) continue;
          if (n.from[y]) can = true;
          else only = false;
        }
        if (can && only) met++;
        else if (can && !taken.has(u)) open.push(u);
      }
      while (met < n.count && open.length > 0) {
        const u = open.splice(Math.floor(this.rng() * open.length), 1)[0];
        let total = 0;
        for (let y = 0; y < K; y++) if (n.from[y] && dom[u * K + y]) total += w[u * K + y];
        let r = this.rng() * total, pick = -1;
        for (let y = 0; y < K; y++) {
          if (!(n.from[y] && dom[u * K + y])) continue;
          pick = y;
          r -= w[u * K + y];
          if (r < 0) break;
        }
        out.push([u, pick]);
        taken.add(u);
        met++;
      }
    }
    return out;
  }

  /** An option for slot s, drawn by weight. */
  pickOption(s: number): number {
    const { K, w } = this.c;
    let r = this.rng() * this.sumW[s];
    let last = -1;
    for (let x = 0; x < K; x++) {
      if (!this.dom[s * K + x]) continue;
      last = x;
      r -= w[s * K + x];
      if (r < 0) return x;
    }
    return last;
  }
}

/** Solve a problem. Throws WfcError when it has no solution (or none was found within the limits). */
export function solve(problem: WfcProblem, settings: WfcSettings): WfcSolution {
  const c = compile(problem);
  if (c.N === 0) return { assignment: new Int32Array(0), ids: [], stats: { decisions: 0, backtracks: 0, restarts: 0, seed: settings.seed >>> 0 } };
  const maxBacktracks = settings.maxBacktracks ?? 2000;
  const maxRestarts = settings.maxRestarts ?? 8;
  let backtracksTotal = 0, decisionsTotal = 0;
  for (let restart = 0; restart <= maxRestarts; restart++) {
    const seed = restart === 0 ? settings.seed >>> 0 : deriveSeed(settings.seed, restart);
    const search = new Search(c, mulberry32(seed));
    if (search.contradiction >= 0) throw new WfcError(`slot ${search.contradiction} has no allowed option`, search.contradiction);
    for (const [s, x] of c.pins) {
      if (!search.dom[s * c.K + x]) throw new WfcError(`slot ${s}: pinned option ${problem.options[x].id} isn't allowed there`, s);
      for (let y = 0; y < c.K; y++) if (y !== x && !search.remove(s, y)) throw new WfcError(`slot ${s}: pin contradiction`, s);
    }
    search.enqueueAll();
    if (!search.checkAllNeeds() || !search.propagate()) {
      throw new WfcError(`no solution: the constraints contradict before any choice (at slot ${search.contradiction})`, search.contradiction);
    }
    // Decisions: [trail mark, slot, option].
    const stack: [number, number, number][] = [];
    let backtracks = 0;
    let solved = false;
    for (;;) {
      const s = search.pickSlot();
      if (s < 0) {
        solved = true;
        break;
      }
      const x = search.pickOption(s);
      decisionsTotal++;
      stack.push([search.mark, s, x]);
      let ok = true;
      for (let y = 0; y < c.K && ok; y++) if (y !== x) ok = search.remove(s, y);
      // Needs are decided with the choice that has them.
      for (const [u, z] of ok ? search.supporters(s, x) : []) {
        for (let y = 0; y < c.K && ok; y++) if (y !== z) ok = search.remove(u, y);
        if (!ok) break;
      }
      ok = ok && search.propagate();
      // Contradiction: undo decisions and ban them until one holds.
      while (!ok) {
        const d = stack.pop();
        if (!d || ++backtracks > maxBacktracks) break;
        search.undo(d[0]);
        ok = search.remove(d[1], d[2]) && search.propagate();
      }
      if (!ok) break;
    }
    backtracksTotal += backtracks;
    if (solved) {
      const assignment = new Int32Array(c.N);
      for (let s = 0; s < c.N; s++) {
        let v = -1;
        for (let x = 0; x < c.K; x++) if (search.dom[s * c.K + x]) v = x;
        assignment[s] = v;
      }
      return {
        assignment,
        ids: Array.from(assignment, (x) => problem.options[x].id),
        stats: { decisions: decisionsTotal, backtracks: backtracksTotal, restarts: restart, seed },
      };
    }
  }
  throw new WfcError(`no solution found after ${maxRestarts} restarts (${backtracksTotal} backtracks)`);
}
