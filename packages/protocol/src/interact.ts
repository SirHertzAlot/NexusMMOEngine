/**
 * Interactions (catalog 0x27, IX1/IX2): the one C→S request for everything E
 * does: open a chest, pick up a ground item, gather from a node, talk to a
 * quest giver, enter a dungeon.
 *
 * - C→S `{kind:"interact", entity}`: use the entity (decimal u64 wire id: a
 *   chest, a ground item, a resource node), or `{kind:"interact", npc}` (a
 *   quest giver's id) or `{kind:"interact", entrance}` (a dungeon entrance's
 *   id), which are content, not entities. The server re-checks reach and
 *   state; a refusal is a 4005 error.
 * - S→C `{kind:"chests", chests}`: world chests (all on joining, then the
 *   ones that changed). `open` chests are empty until their refill timer.
 */

export type InteractAction = { kind: "interact"; entity: string } | { kind: "interact"; npc: string } | { kind: "interact"; entrance: string };

export interface ChestView {
  /** The chest entity's wire id (decimal u64). */
  entity: string;
  x: number;
  z: number;
  /** A chest is open (empty) until it refills; a door is open until shut. */
  open: boolean;
  /** Absent: a chest. */
  kind?: "door";
}

export interface ChestsMessage {
  kind: "chests";
  chests: ChestView[];
}
