/**
 * Filtering the content palette (roadmap EB4).
 *
 * The placeables used to be three wrapping rows of chips under the canvas,
 * capped at six rem of height: fine for the eight things a fixture scene
 * has, useless against the real roster (19 creatures, the spawn table's
 * archetypes and every PICG asset). The palette searches instead, and this
 * is the search: pure, so the ordering and the "nothing matched" case can
 * be tested without mounting anything.
 */

export interface PlaceableItem {
  id: string;
  label: string;
}

export interface PlaceableGroup {
  /** The group's name, as the palette shows it. */
  title: string;
  items: PlaceableItem[];
}

export interface PlaceableSource {
  species: PlaceableItem[];
  props: PlaceableItem[];
  pcg: PlaceableItem[];
}

/** The groups in the order the palette lists them. */
export const PLACEABLE_GROUPS: ReadonlyArray<[keyof PlaceableSource, string]> = [
  ["species", "Creatures"],
  ["props", "Props"],
  ["pcg", "PICG"],
];

const norm = (s: string): string => s.trim().toLowerCase();

/** Whether `item` matches `query` on either its id or its label. */
export function matchesPlaceable(item: PlaceableItem, query: string): boolean {
  const q = norm(query);
  if (q.length === 0) return true;
  return norm(item.id).includes(q) || norm(item.label).includes(q);
}

/**
 * `source` as groups, keeping the group order above, dropping groups that
 * no item matched, and keeping each group's own order (the host already
 * lists them the way the content files do).
 */
export function filterPlaceables(source: PlaceableSource | null, query: string): PlaceableGroup[] {
  if (!source) return [];
  const out: PlaceableGroup[] = [];
  for (const [key, title] of PLACEABLE_GROUPS) {
    const items = (source[key] ?? []).filter((it) => matchesPlaceable(it, query));
    if (items.length > 0) out.push({ title, items });
  }
  return out;
}

/** How many placeables there are in all, matched and not. */
export function placeableCount(source: PlaceableSource | null): number {
  if (!source) return 0;
  return PLACEABLE_GROUPS.reduce((n, [key]) => n + (source[key]?.length ?? 0), 0);
}

/** The line under the search box: what is showing, out of what there is. */
export function paletteSummary(source: PlaceableSource | null, groups: PlaceableGroup[], query: string): string {
  const total = placeableCount(source);
  if (source === null) return "Loading…";
  if (total === 0) return "Nothing to place.";
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  if (query.trim().length === 0) return `${total} to place`;
  return shown === 0 ? `No match for "${query.trim()}"` : `${shown} of ${total}`;
}
