/**
 * The dungeon bake document's types, empty document, and the theme and layer
 * ids the panel offers. No imports: the browser bundle takes this module, and
 * the dungeon package's index can't go in the browser (it reads files). A test
 * keeps these ids in step with the dungeon package's CRYPT_THEMES.
 */
import type { PortalKind } from "./portal-kind.js";

export type PaintCell = "#" | "." | "p";

export interface LayerEdit {
  density?: number;
  budget?: number;
}

export interface PortalSpec {
  id: string;
  x: number;
  y: number;
  side: "x" | "y";
  kind?: PortalKind;
  /** Wall cells the opening takes, along the wall (default 1). */
  width?: number;
  /** The floor level the portal leads to (absent: the level it stands on). */
  targetLevel?: number;
}

export interface DungeonBakeDoc {
  /** The layout's name: where the bake's provenance points. */
  id: string;
  theme: string;
  rows: string[];
  entrance: { x: number; y: number };
  portals: Array<PortalSpec & { kind: PortalKind; width: number }>;
  /** Edits to a theme's layers, by layer id. */
  layerEdits: Record<string, LayerEdit>;
}

export type DocOp =
  | { op: "paint"; x: number; y: number; cell: PaintCell }
  | { op: "placePortal"; portal: PortalSpec }
  | { op: "removePortal"; id: string }
  | { op: "setTheme"; theme: string }
  | { op: "editLayer"; layer: string; field: keyof LayerEdit; value: number };

/** The themes the editor offers (the dungeon package's CRYPT_THEMES keys). */
export const BAKE_THEMES = ["dry-crypt", "damp-crypt"] as const;

/** Each theme's layer ids, in order (the dungeon package's CRYPT_THEMES layers). */
export const BAKE_LAYERS: Record<string, readonly string[]> = {
  "dry-crypt": ["rubble", "torch"],
  "damp-crypt": ["moss", "mushroom", "torch"],
};

/** A starting document: a room, the default theme, nothing placed. */
export function emptyDoc(id: string): DungeonBakeDoc {
  return {
    id,
    theme: "dry-crypt",
    rows: ["#########", "#.......#", "#.......#", "#.......#", "#########"],
    entrance: { x: 1, y: 1 },
    portals: [],
    layerEdits: {},
  };
}
