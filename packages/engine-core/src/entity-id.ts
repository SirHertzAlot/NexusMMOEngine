/**
 * Wire entity-id mapping (architecture brief §2, "Entity identity").
 *
 * The wire id is a u64: high 32 bits = generation, low 32 = slot index.
 * - The bitECS eid doubles as the slot index (slice 1.2).
 * - The generation bumps whenever a slot is reused (ABA guard).
 * - Ids are server-issued; the client never mints them.
 *
 * Single implementation shared by world, net, and persist code (DRY).
 */

const U32_MAX = 0xffffffff;
const U64_MAX = 0xffffffffffffffffn;

export function makeWireEntityId(generation: number, slot: number): bigint {
  if (!Number.isInteger(generation) || generation < 0 || generation > U32_MAX) {
    throw new RangeError(`generation out of u32 range: ${generation}`);
  }
  if (!Number.isInteger(slot) || slot < 0 || slot > U32_MAX) {
    throw new RangeError(`slot out of u32 range: ${slot}`);
  }
  return (BigInt(generation) << 32n) | BigInt(slot);
}

export function parseWireEntityId(id: bigint): {
  generation: number;
  slot: number;
} {
  if (typeof id !== "bigint" || id < 0n || id > U64_MAX) {
    throw new RangeError(`entity id out of u64 range: ${String(id)}`);
  }
  return {
    generation: Number((id >> 32n) & BigInt(U32_MAX)),
    slot: Number(id & BigInt(U32_MAX)),
  };
}
