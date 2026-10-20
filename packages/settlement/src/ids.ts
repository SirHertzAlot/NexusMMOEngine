/**
 * Stable entity ids: kind, settlement and the position in the generated
 * hierarchy, zero-padded so a plain sort is index order. Never an array index
 * on its own: the id names the parent chain, so a regenerated settlement
 * keeps the ids of what did not change.
 */

export function entityId(kind: string, settlement: string, ...path: number[]): string {
  return [kind, settlement, ...path.map((n) => String(n).padStart(4, "0"))].join("_");
}
