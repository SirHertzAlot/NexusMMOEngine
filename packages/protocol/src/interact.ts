/**
 * Interactions (catalog 0x27, IX1): one C→S request for anything in the world
 * that opens, searches or is used with E. Chests are the first target; the
 * other E actions (pickup, gather, talk, enter) move onto this op in IX2.
 *
 * - C→S `{kind:"interact", entity}`: use the entity (decimal u64 wire id).
 *   The server re-checks reach and state; a refusal is a 4005 error.
 * - S→C `{kind:"chests", chests}`: world chests (all on joining, then the
 *   ones that changed). `open` chests are empty until their refill timer.
 */

export interface InteractAction {
  kind: "interact";
  entity: string;
}

export interface ChestView {
  /** The chest entity's wire id (decimal u64). */
  entity: string;
  x: number;
  z: number;
  open: boolean;
}

export interface ChestsMessage {
  kind: "chests";
  chests: ChestView[];
}
