/**
 * Gathering (catalog 0x24): the resource nodes round the towns (tree
 * stands, ore veins, fishing spots) and the player's materials pouch.
 * The server owns every node's stock; the client learns what a node is
 * from `resources` and asks to `gather` from it.
 */

/** C→S: gather once from the resource node `entity` (a wire id). */
export interface GatherAction {
  kind: "gather";
  entity: string;
}

/** A resource node as the client sees it. */
export interface ResourceNodeView {
  /** The node's entity (wire id). */
  entity: string;
  /** tree_stand, ore_vein, fishing_spot. */
  kind: string;
  /** The material it gives (a crafting material id) and its name. */
  material: string;
  name: string;
  tier: number;
  /** The skill that gathers it (Woodcutting, Mining, Fishing). */
  skill: string;
  /** Gathers left, and how many it holds when full. */
  stock: number;
  max: number;
  /** Its footprint, metres (x, z): gathering reaches from its edge. */
  size: [number, number];
  /** When a worked-out node comes back (unix ms); null while it has stock or when it never does. */
  regrowAt: number | null;
}

/** S→C: every node on joining, then the nodes that changed (gathered from, worked out, grown back). */
export interface ResourcesMessage {
  kind: "resources";
  nodes: ResourceNodeView[];
}

export interface PouchMaterial {
  material: string;
  name: string;
  tier: number;
  count: number;
}

/** S→C (owner only): the whole pouch, on joining and after every gather; `gathered` names what was just added. */
export interface PouchMessage {
  kind: "pouch";
  materials: PouchMaterial[];
  gathered?: { material: string; name: string; count: number };
}
