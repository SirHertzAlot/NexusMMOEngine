/**
 * DeltaSet (catalog 0x25, interest management): one message per client per
 * tick, the concatenation of shared per-sector bytes. The core encodes each
 * sector's Delta once; whoever assembles (the edge, or the gateway when no
 * edge) only copies bytes.
 *
 * Layout (little endian):
 *   u32 tick, u8 flags (bit 0: replace, the mirror clears first), u16 count,
 *   then per entry: u8 kind, u8 sector length, sector (utf8), u32 length, bytes.
 * Entry bytes are a Delta payload (codec decodeDelta) for delta/full/pinned,
 * empty for leave. Sector "g" is the global entry: entities without a home
 * sector, and the tick's true spawn and despawn ids.
 */

export const DeltaSetKind = { Delta: 0, Full: 1, Leave: 2, Pinned: 3 } as const;
export type DeltaSetKind = (typeof DeltaSetKind)[keyof typeof DeltaSetKind];

/** The global entry's sector. */
export const GLOBAL_SECTOR = "g";

export interface DeltaSetEntry {
  kind: DeltaSetKind;
  sector: string;
  bytes: Uint8Array;
}

export interface DeltaSet {
  tick: number;
  replace: boolean;
  entries: DeltaSetEntry[];
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** Assemble a DeltaSet payload (no envelope byte): copies of the entries' bytes. */
export function encodeDeltaSet(set: DeltaSet): Uint8Array {
  const names = set.entries.map((e) => utf8.encode(e.sector));
  let size = 7;
  for (let i = 0; i < set.entries.length; i++) size += 6 + names[i].length + set.entries[i].bytes.length;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, set.tick >>> 0, true);
  out[4] = set.replace ? 1 : 0;
  v.setUint16(5, set.entries.length, true);
  let o = 7;
  for (let i = 0; i < set.entries.length; i++) {
    const e = set.entries[i];
    out[o++] = e.kind;
    out[o++] = names[i].length;
    out.set(names[i], o);
    o += names[i].length;
    v.setUint32(o, e.bytes.length, true);
    o += 4;
    out.set(e.bytes, o);
    o += e.bytes.length;
  }
  return out;
}

export function decodeDeltaSet(buf: Uint8Array): DeltaSet {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 7) throw new Error("deltaset: truncated header");
  const tick = v.getUint32(0, true);
  const replace = (buf[4] & 1) === 1;
  const count = v.getUint16(5, true);
  const entries: DeltaSetEntry[] = [];
  let o = 7;
  for (let i = 0; i < count; i++) {
    if (o + 2 > buf.length) throw new Error("deltaset: truncated entry");
    const kind = buf[o++] as DeltaSetKind;
    if (kind > 3) throw new Error(`deltaset: unknown entry kind ${kind}`);
    const n = buf[o++];
    if (o + n + 4 > buf.length) throw new Error("deltaset: truncated entry");
    const sector = fromUtf8.decode(buf.subarray(o, o + n));
    o += n;
    const len = v.getUint32(o, true);
    o += 4;
    if (o + len > buf.length) throw new Error("deltaset: truncated entry bytes");
    entries.push({ kind, sector, bytes: buf.subarray(o, o + len) });
    o += len;
  }
  return { tick, replace, entries };
}
