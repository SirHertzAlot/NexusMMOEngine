/** The content catalog's shapes (EA15), browser-safe: the host builds them (content-catalog.ts), the content browser and the scene viewport read them. */

export const CATALOG_KINDS = ["species", "creature", "item", "prefab", "picg", "scene", "quest"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

/** A scene node without its id (the viewport assigns one on drop). */
export interface NodeTemplate {
  name: string;
  kind?: string;
  prefab?: string;
  components?: Record<string, Record<string, unknown>>;
}

export interface CatalogEntry {
  kind: CatalogKind;
  id: string;
  label: string;
  detail: string;
  /** The payload a drag carries. */
  drag: { kind: CatalogKind; id: string };
  node: NodeTemplate | null;
}

export interface Catalog {
  entries: CatalogEntry[];
  /** What the catalog can't list yet, and why. */
  notes: string[];
}
