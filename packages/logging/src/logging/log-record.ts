/**
 * SAB Logging Layer — Binary Record Layout (docs/SAB-LOGGING-LAYER-SPEC.md §2.2)
 *
 * 128-byte fixed, language-neutral binary layout.
 * Shared verbatim between TypeScript and C++.
 */

export const RECORD_BYTES = 128;
export const RECORD_WORDS_U32 = 32;

export const RECORD_LAYOUT = {
  HEADER_WORD: 0, // [level: u8 | producer: u8 | code: u16]
  TICK_WORD: 1, // tick: u32
  TIMESTAMP_LO_WORD: 2, // timestamp_ns: u64 (lo)
  TIMESTAMP_HI_WORD: 3, // timestamp_ns: u64 (hi)
  ENTITY_REF_LO_WORD: 4, // entityRef: u64 (lo)
  ENTITY_REF_HI_WORD: 5, // entityRef: u64 (hi)
  ARGS_START_WORD: 6, // 4 x u64 (8 words = words 6..13)
  INLINE_STR_START_WORD: 14, // 64 bytes = 16 words (words 14..29)
  ARG_TAGS_WORD: 30, // 4 x u8 tags
  FLAGS_VERSION_WORD: 31, // [flags: u16 | version: u16]
} as const;

export const ARG_TAGS = {
  EMPTY: 0,
  I32: 1,
  U32: 2,
  F32: 3,
  I64: 4,
  U64: 5,
  F64: 6,
  STRING_INTERNED: 7,
  STRING_INLINE: 8,
} as const;

export interface LogRecordView {
  level: number;
  producer: number;
  code: number;
  tick: number;
  timestampNs: bigint;
  entityRef: bigint;
  args: Array<number | bigint | string | boolean>;
  inlineString: string;
}

const textDecoder = new TextDecoder("utf-8");
const textEncoder = new TextEncoder();
const scratchF32 = new Float32Array(1);
const scratchU32 = new Uint32Array(scratchF32.buffer);

/**
 * Decode a 128-byte slot into a friendly LogRecordView.
 */
export function decodeLogRecord(
  data: Uint32Array,
  baseWord: number,
): LogRecordView {
  const header = data[baseWord + RECORD_LAYOUT.HEADER_WORD];
  const level = header & 0xff;
  const producer = (header >>> 8) & 0xff;
  const code = (header >>> 16) & 0xffff;
  const tick = data[baseWord + RECORD_LAYOUT.TICK_WORD];

  const tsLo = BigInt(data[baseWord + RECORD_LAYOUT.TIMESTAMP_LO_WORD]);
  const tsHi = BigInt(data[baseWord + RECORD_LAYOUT.TIMESTAMP_HI_WORD]);
  const timestampNs = (tsHi << 32n) | tsLo;

  const entLo = BigInt(data[baseWord + RECORD_LAYOUT.ENTITY_REF_LO_WORD]);
  const entHi = BigInt(data[baseWord + RECORD_LAYOUT.ENTITY_REF_HI_WORD]);
  const entityRef = (entHi << 32n) | entLo;

  // Extract inline string if present
  const byteOffset = (baseWord + RECORD_LAYOUT.INLINE_STR_START_WORD) * 4;
  const strBytes = new Uint8Array(data.buffer, data.byteOffset + byteOffset, 64);
  let nullIdx = 0;
  while (nullIdx < 64 && strBytes[nullIdx] !== 0) nullIdx++;
  const inlineString = nullIdx > 0 ? textDecoder.decode(strBytes.subarray(0, nullIdx)) : "";

  // Extract args
  const tagsWord = data[baseWord + RECORD_LAYOUT.ARG_TAGS_WORD];
  const args: Array<number | bigint | string | boolean> = [];
  const argsBase = baseWord + RECORD_LAYOUT.ARGS_START_WORD;

  for (let i = 0; i < 4; i++) {
    const tag = (tagsWord >>> (i * 8)) & 0xff;
    if (tag === ARG_TAGS.EMPTY) {
      if (inlineString.length > 0 && args.length === 0) {
        args.push(inlineString);
      }
      break;
    }
    const lo = BigInt(data[argsBase + i * 2]);
    const hi = BigInt(data[argsBase + i * 2 + 1]);
    const valU64 = (hi << 32n) | lo;

    if (tag === ARG_TAGS.I32 || tag === ARG_TAGS.U32) {
      args.push(Number(lo));
    } else if (tag === ARG_TAGS.STRING_INLINE) {
      const offset = Number(lo & 0xffffn);
      const len = Number((lo >> 16n) & 0xffffn);
      if (len > 0 && offset + len <= 64) {
        args.push(textDecoder.decode(strBytes.subarray(offset, offset + len)));
      } else {
        args.push(inlineString);
      }
    } else if (tag === ARG_TAGS.I64 || tag === ARG_TAGS.U64) {
      args.push(valU64);
    } else if (tag === ARG_TAGS.F32) {
      // C++ producers write IEEE-754 float bits into the lo word; re-interpreting
      // them as a float keeps parity between TS- and C++-emitted records.
      scratchU32[0] = Number(lo);
      args.push(scratchF32[0]);
    } else {
      args.push(Number(lo));
    }
  }

  return {
    level,
    producer,
    code,
    tick,
    timestampNs,
    entityRef,
    args,
    inlineString,
  };
}
