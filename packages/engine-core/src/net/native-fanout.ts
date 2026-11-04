import { createRequire } from "node:module";
import type { DeltaSetEntry } from "@mmo-engine/protocol";
import type { ClientSession } from "../session.js";

/**
 * Native per-tick fan-out (packages/addons/fanout). One call assembles every session's DeltaSet
 * envelope into a shared arena and one call picks the entity names each session still needs, in
 * place of the per-session JavaScript (encodeDeltaSet, encodeEnvelope, the BigInt "named" Set).
 * On by default (benchmarked about 2x faster ticks at 200, 500 and 1,000 clients); MMO_NATIVE_FANOUT=0 or a missing addon keeps the JavaScript path.
 */
interface FanoutInstance {
  setName(idx: number, utf8: Uint8Array): void;
  assemble(tick: number, arena: Uint8Array, out: Int32Array, desc: Int32Array, descLen: number, payloads: Uint8Array[]): number;
  selectNames(secStart: Int32Array, secLen: Int32Array, ids: BigUint64Array, desc: Int32Array, descLen: number, pids: BigUint64Array, wantCount: Int32Array): number;
  takeWanted(out: BigUint64Array): void;
  release(slot: number): void;
  stats(): { calls: number; sectorRefs: number; sectorRefsSkipped: number; idsScanned: number };
}

const utf8 = new TextEncoder();

function defaultLoad(): FanoutAddon {
  return createRequire(import.meta.url)("@mmo-engine/addon-fanout") as FanoutAddon;
}

/** The loaded module: one Fanout object per gateway, so gateways in one process do not share state. */
export interface FanoutAddon {
  Fanout: new () => FanoutInstance;
  version(): string;
}

/** Which path the gateway fans out on, and why: logged at startup and readable at runtime. */
export interface FanoutStatus {
  path: "native" | "js";
  reason: string;
}

/**
 * Load the native fan-out. Never throws: a disabled flag or an addon that is missing or built for another
 * ABI leaves the JavaScript path (same bytes, slower) and says why in `status`.
 */
export function loadNativeFanout(load: () => FanoutAddon = defaultLoad): { fanout: NativeFanout | null; status: FanoutStatus } {
  if (process.env.MMO_NATIVE_FANOUT === "0") return { fanout: null, status: { path: "js", reason: "MMO_NATIVE_FANOUT=0" } };
  try {
    const addon = load();
    return { fanout: new NativeFanout(new addon.Fanout()), status: { path: "native", reason: `addon-fanout ${addon.version()}` } };
  } catch (err) {
    return { fanout: null, status: { path: "js", reason: `addon unavailable: ${(err as Error).message.split("\n")[0]}` } };
  }
}

/** What the gateway delivers to one session this tick. */
export interface FanoutResult {
  /** The session's 0x25 envelope: a view into the arena, valid until the next tick's begin(). */
  env: Uint8Array;
  /** Wire ids whose names this session has not been told yet, or null. */
  want: bigint[] | null;
  /** Set when the native call failed: the names were not selected, so the JavaScript rule applies. */
  jsNames?: boolean;
  /** With sharing on: the equivalence group whose envelope this is (sessions of one group got the same bytes). */
  group?: number;
}

/** How equivalent envelopes are handled: "off" assembles one per session; "assembly" one per group (still sent per session); "publish" is decided by the Gateway. */
export type FanoutShare = "off" | "assembly" | "publish";

export class NativeFanout {
  private readonly nameIdx = new Map<string, number>();
  private slots = 0;
  private readonly free: number[] = [];
  private readonly slotOf = new Map<string, number>();
  private tickNo = 0;
  private tickSeq = 0;
  private sessions: ClientSession[] = [];
  private desc = new Int32Array(1 << 14);
  private descLen = 0;
  private nameDesc = new Int32Array(1 << 14);
  private nameDescLen = 0;
  private pids = new BigUint64Array(1 << 10);
  private pidsLen = 0;
  private payloads: Uint8Array[] = [];
  private readonly payloadIdx = new Map<Uint8Array, number>();
  private secLastTag = new Uint32Array(512);
  private secLastBytes: Array<Uint8Array | undefined> = new Array(512);
  private secLastIdx = new Int32Array(512);
  private out = new Int32Array(2048);
  private wantCount = new Int32Array(1024);
  private arena = new Uint8Array(1 << 20);
  private secStart = new Int32Array(64);
  private secLen = new Int32Array(64);
  private ids = new BigUint64Array(1 << 10);
  private hasNames = false;
  private results: FanoutResult[] = [];
  private groupEnvs: Uint8Array[] = [];
  /** Sharing mode (MMO_FANOUT_SHARE=off|assembly|publish, default assembly): sessions whose entry lists are identical get one assembled envelope. */
  readonly share: FanoutShare;
  private groupTable = new Int32Array(4096).fill(-1);
  private groupTableMask = 4095;
  private groupTableUsed = new Int32Array(4096);
  private groupTableUsedLen = 0;
  private groupDescOff = new Int32Array(1024);
  private groupDescLen = new Int32Array(1024);
  private groupCount = 0;
  private groupKeys: Array<string | undefined> = [];
  private readonly entriesObjGroup = new Map<readonly DeltaSetEntry[], number>();
  private readonly sectorSetCache = new WeakMap<ReadonlySet<string>, { size: number; ids: Int32Array }>();
  private sessionGroup: number[] = [];
  /** Milliseconds spent in each native call since boot, for metrics and benchmarks. */
  readonly ms = { selectNames: 0, assemble: 0 };
  /** Sizes of the work handed to the addon since boot. */
  readonly count = { ticks: 0, sessions: 0, namedIds: 0, sectorRefs: 0, wanted: 0, envelopeBytes: 0, assembledBytes: 0, groups: 0 };

  constructor(private readonly addon: FanoutInstance, share?: FanoutShare) {
    const env = process.env.MMO_FANOUT_SHARE;
    // Default "assembly": sessions with identical entry lists share one assembled envelope (benchmarked 2026-11-03).
    this.share = share ?? (env === "off" || env === "publish" ? env : "assembly");
  }

  /** The key of an equivalence group (same tick, replace flag and entry list): a stable topic name for publish. */
  groupKey(g: number): string {
    let k = this.groupKeys[g];
    if (k === undefined) {
      const d = this.desc;
      let o = this.groupDescOff[g];
      const n = d[o++];
      k = d[o++] ? "r" : "d";
      for (let i = 0; i < n; i++) {
        k += `${d[o]}.${d[o + 1]}.${d[o + 2]},`;
        o += 3;
      }
      this.groupKeys[g] = k;
    }
    return k;
  }

  private growSecPayloadCache(minSize: number): void {
    const n = Math.max(minSize * 2, 512);
    const t = new Uint32Array(n);
    t.set(this.secLastTag);
    this.secLastTag = t;
    this.secLastBytes.length = n;
    const idx = new Int32Array(n);
    idx.set(this.secLastIdx);
    this.secLastIdx = idx;
  }

  private growGroupArrays(minGroups: number): void {
    const n = Math.max(minGroups * 2, 1024);
    const off = new Int32Array(n);
    off.set(this.groupDescOff);
    this.groupDescOff = off;
    const len = new Int32Array(n);
    len.set(this.groupDescLen);
    this.groupDescLen = len;
    if (n * 2 > this.groupTable.length) {
      let cap = this.groupTable.length;
      while (cap < n * 2) cap <<= 1;
      this.groupTable = new Int32Array(cap).fill(-1);
      this.groupTableMask = cap - 1;
      this.groupTableUsed = new Int32Array(cap);
      this.groupTableUsedLen = 0;
    }
  }

  /** Start a tick. `bySector` is the named entities by home sector, or null when names are off. */
  begin(tick: number, bySector: ReadonlyMap<string, bigint[]> | null): void {
    this.tickNo = tick;
    this.tickSeq = ((this.tickSeq + 1) >>> 0) || 1;
    this.sessions.length = 0;
    this.descLen = 0;
    this.nameDescLen = 0;
    this.pidsLen = 0;
    this.payloads.length = 0;
    this.payloadIdx.clear();
    for (let i = 0; i < this.groupTableUsedLen; i++) {
      this.groupTable[this.groupTableUsed[i]] = -1;
    }
    this.groupTableUsedLen = 0;
    this.groupCount = 0;
    this.groupKeys.length = 0;
    this.entriesObjGroup.clear();
    this.sessionGroup.length = 0;
    this.hasNames = bySector !== null;
    if (bySector) {
      for (const k of bySector.keys()) this.indexOf(k);
      if (this.secStart.length < this.nameIdx.size) {
        this.secStart = new Int32Array(this.nameIdx.size * 2);
        this.secLen = new Int32Array(this.nameIdx.size * 2);
      }
      this.secLen.fill(0, 0, this.nameIdx.size);
      let n = 0;
      for (const l of bySector.values()) n += l.length;
      if (this.ids.length < n) this.ids = new BigUint64Array(n * 2);
      let at = 0;
      for (const [k, l] of bySector) {
        const i = this.nameIdx.get(k)!;
        this.secStart[i] = at;
        this.secLen[i] = l.length;
        for (let j = 0; j < l.length; j++) this.ids[at++] = l[j];
      }
    }
  }

  private secStartTotal(): number {
    let n = 0;
    for (let i = 0; i < this.nameIdx.size; i++) n += this.secLen[i];
    return n;
  }

  private indexOf(sector: string): number {
    let i = this.nameIdx.get(sector);
    if (i === undefined) {
      i = this.nameIdx.size;
      this.nameIdx.set(sector, i);
      this.addon.setName(i, utf8.encode(sector));
    }
    return i;
  }

  private slotFor(s: ClientSession): number {
    let slot = this.slotOf.get(s.clientId);
    if (slot === undefined) {
      slot = this.free.pop() ?? this.slots++;
      this.slotOf.set(s.clientId, slot);
    }
    return slot;
  }

  /** Counters from the addon: sector references seen, skipped by the version check, and ids scanned. */
  nativeStats(): ReturnType<FanoutInstance["stats"]> {
    return this.addon.stats();
  }

  /** Free the native state of sessions that are gone (call now and then). */
  sweep(live: ReadonlyMap<string, unknown>): void {
    for (const [id, slot] of this.slotOf) {
      if (live.has(id)) continue;
      this.slotOf.delete(id);
      this.addon.release(slot);
      this.free.push(slot);
    }
  }

  /** Queue one session. Its interestSet must already be the one `entries` was computed with. */
  add(s: ClientSession, replace: boolean, entries: readonly DeltaSetEntry[]): void {
    this.sessions.push(s);
    const shareOn = this.share !== "off";
    const fastG = shareOn && !replace ? this.entriesObjGroup.get(entries) : undefined;
    if (fastG !== undefined) {
      this.sessionGroup.push(fastG);
    } else {
      const nEntries = entries.length;
      const needDesc = this.descLen + 2 + nEntries * 3;
      if (needDesc > this.desc.length) {
        const bigger = new Int32Array(needDesc * 2);
        bigger.set(this.desc.subarray(0, this.descLen));
        this.desc = bigger;
      }
      const d = this.desc;
      const base = this.descLen;
      let o = base;
      d[o++] = nEntries;
      d[o++] = replace ? 1 : 0;
      let h = (replace ? 0x811c9dc5 : 0x01000193) ^ nEntries;
      const tickSeq = this.tickSeq;
      for (let i = 0; i < nEntries; i++) {
        const e = entries[i];
        const si = this.indexOf(e.sector);
        const slot = (si << 2) | (e.kind & 3);
        let p: number;
        if (slot < this.secLastTag.length && this.secLastTag[slot] === tickSeq && this.secLastBytes[slot] === e.bytes) {
          p = this.secLastIdx[slot];
        } else {
          let found = this.payloadIdx.get(e.bytes);
          if (found === undefined) {
            found = this.payloads.length;
            this.payloads.push(e.bytes);
            this.payloadIdx.set(e.bytes, found);
          }
          p = found;
          if (slot >= this.secLastTag.length) this.growSecPayloadCache(slot + 1);
          this.secLastTag[slot] = tickSeq;
          this.secLastBytes[slot] = e.bytes;
          this.secLastIdx[slot] = p;
        }
        d[o++] = e.kind;
        d[o++] = si;
        d[o++] = p;
        if (shareOn) {
          h = Math.imul(h ^ ((e.kind & 3) | (si << 2) | (p << 16)), 0x01000193);
        }
      }
      if (!shareOn) {
        this.sessionGroup.push(this.sessionGroup.length);
        this.descLen = o;
      } else {
        if (this.groupCount + 1 >= this.groupDescOff.length) {
          this.growGroupArrays(this.groupCount + 1);
        }
        const len = o - base;
        const table = this.groupTable;
        const mask = this.groupTableMask;
        let tSlot = (h ^ (h >>> 16)) & mask;
        let g = -1;
        while (true) {
          const cand = table[tSlot];
          if (cand === -1) {
            g = this.groupCount++;
            table[tSlot] = g;
            this.groupTableUsed[this.groupTableUsedLen++] = tSlot;
            this.groupDescOff[g] = base;
            this.groupDescLen[g] = len;
            this.descLen = o;
            break;
          }
          if (this.groupDescLen[cand] === len) {
            const cOff = this.groupDescOff[cand];
            let match = true;
            for (let k = 1; k < len; k++) {
              if (d[cOff + k] !== d[base + k]) {
                match = false;
                break;
              }
            }
            if (match) {
              g = cand;
              break;
            }
          }
          tSlot = (tSlot + 1) & mask;
        }
        if (!replace) this.entriesObjGroup.set(entries, g);
        this.sessionGroup.push(g);
      }
    }
    if (!this.hasNames) return;
    const pinned = s.pinnedOut;
    const player = s.playerEntity;
    const sectors = s.interestSet;
    const nSec = sectors ? sectors.size : 0;
    this.count.sectorRefs += nSec;
    const nPin = pinned ? pinned.size : 0;
    const need = this.nameDescLen + 4 + nSec;
    if (need > this.nameDesc.length) {
      const bigger = new Int32Array(need * 2);
      bigger.set(this.nameDesc.subarray(0, this.nameDescLen));
      this.nameDesc = bigger;
    }
    const nd = this.nameDesc;
    let q = this.nameDescLen;
    nd[q++] = this.slotFor(s);
    nd[q++] = player !== null ? 1 : 0;
    // Sectors that are not in this tick's table have no named entities: index them anyway (length 0).
    nd[q++] = nSec;
    nd[q++] = nPin;
    if (sectors && nSec > 0) {
      let cached = this.sectorSetCache.get(sectors);
      if (!cached || cached.size !== nSec) {
        const ids = new Int32Array(nSec);
        let at = 0;
        for (const k of sectors) ids[at++] = this.indexOf(k);
        cached = { size: nSec, ids };
        this.sectorSetCache.set(sectors, cached);
      }
      nd.set(cached.ids, q);
      q += nSec;
    }
    this.nameDescLen = q;
    const nIds = (player !== null ? 1 : 0) + nPin;
    if (this.pidsLen + nIds > this.pids.length) {
      const bigger = new BigUint64Array((this.pidsLen + nIds) * 2);
      bigger.set(this.pids.subarray(0, this.pidsLen));
      this.pids = bigger;
    }
    if (player !== null) this.pids[this.pidsLen++] = player;
    if (pinned && nPin > 0) for (const w of pinned) this.pids[this.pidsLen++] = w;
  }

  /** Run the native calls for the queued sessions; results are in queue order. */
  run(): FanoutResult[] {
    const n = this.sessions.length;
    this.results.length = 0;
    if (n === 0) return this.results;
    // Sectors indexed by add() after begin() sized the table have no ids: widen with zero lengths.
    if (this.hasNames && this.secStart.length < this.nameIdx.size) {
      const a = new Int32Array(this.nameIdx.size * 2), b = new Int32Array(this.nameIdx.size * 2);
      a.set(this.secStart);
      b.set(this.secLen);
      this.secStart = a;
      this.secLen = b;
    }
    let wants: bigint[][] | null = null;
    if (this.hasNames) {
      if (this.wantCount.length < n) this.wantCount = new Int32Array(n * 2);
      const t0 = performance.now();
      const total = this.addon.selectNames(this.secStart, this.secLen, this.ids, this.nameDesc, this.nameDescLen, this.pids, this.wantCount);
      this.ms.selectNames += performance.now() - t0;
      this.count.namedIds += this.ids.length > 0 ? this.secStartTotal() : 0;
      this.count.wanted += total;
      if (total > 0) {
        const w = new BigUint64Array(total);
        this.addon.takeWanted(w);
        wants = [];
        let at = 0;
        for (let i = 0; i < n; i++) {
          const c = this.wantCount[i];
          if (c === 0) { wants.push(EMPTY); continue; }
          const list: bigint[] = new Array(c);
          for (let j = 0; j < c; j++) list[j] = w[at++];
          wants.push(list);
        }
      }
    }
    const groups = this.share === "off" ? n : this.groupCount;
    if (this.out.length < groups * 2) this.out = new Int32Array(groups * 2 * 2);
    const t1 = performance.now();
    let r = this.addon.assemble(this.tickNo, this.arena, this.out, this.desc, this.descLen, this.payloads);
    if (r < 0) {
      this.arena = new Uint8Array(Math.ceil(-r * 1.5));
      r = this.addon.assemble(this.tickNo, this.arena, this.out, this.desc, this.descLen, this.payloads);
    }
    this.ms.assemble += performance.now() - t1;
    this.count.ticks++;
    this.count.sessions += n;
    this.count.groups += groups;
    this.count.assembledBytes += this.out[(groups - 1) * 2] + this.out[(groups - 1) * 2 + 1];
    const groupEnvs = this.groupEnvs;
    groupEnvs.length = groups;
    for (let g = 0; g < groups; g++) {
      const off = this.out[g * 2];
      const len = this.out[g * 2 + 1];
      groupEnvs[g] = this.arena.subarray(off, off + len);
    }
    for (let i = 0; i < n; i++) {
      const g = this.sessionGroup[i];
      const env = groupEnvs[g];
      this.count.envelopeBytes += env.byteLength;
      const w = wants ? wants[i] : EMPTY;
      this.results.push({ env, want: w.length > 0 ? w : null, group: g });
    }
    return this.results;
  }
}

const EMPTY: bigint[] = [];
