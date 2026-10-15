/**
 * The Scale view's rules (browser-safe, pure): edits of a ScaleDoc, each
 * returning a new document so `useDocument` history and these tests see the
 * same thing, and the gauge that sizes the art catalog against a character.
 * Validation is `validateScale` of @mmo-engine/scene, the code the host
 * refuses a save with.
 */
import { resolveScale, SCALE_CATEGORIES, type ScaleCategory, type ScaleDoc } from "@mmo-engine/scene";

export const CHARACTER_HEIGHT = 1.8;
/** Sane typical heights in metres per category (a prop has no band). */
export const BANDS: Partial<Record<ScaleCategory, readonly [number, number]>> = {
  building: [3, 14],
  tree: [4, 30],
  rock: [0.3, 8],
  plant: [0.1, 4],
};

export const setGlobal = (doc: ScaleDoc, global: number): ScaleDoc => ({ ...doc, global });

/** A category's factor; undefined removes it (counts as 1). */
export function setCategory(doc: ScaleDoc, category: ScaleCategory, factor: number | undefined): ScaleDoc {
  const { [category]: _gone, ...rest } = doc.categories;
  return { ...doc, categories: factor === undefined ? rest : { ...rest, [category]: factor } };
}

export const setAsset = (doc: ScaleDoc, key: string, factor: number): ScaleDoc => ({ ...doc, assets: { ...doc.assets, [key]: factor } });

export function removeAsset(doc: ScaleDoc, key: string): ScaleDoc {
  const { [key]: _gone, ...rest } = doc.assets;
  return { ...doc, assets: rest };
}

/** A row's id changed in place (order and factor kept); an empty or taken id changes nothing. */
export function renameAsset(doc: ScaleDoc, from: string, to: string): ScaleDoc {
  const name = to.trim();
  if (name === "" || (name !== from && name in doc.assets) || !(from in doc.assets)) return doc;
  return { ...doc, assets: Object.fromEntries(Object.entries(doc.assets).map(([k, v]) => [k === from ? name : k, v])) };
}

/** A typed factor, or null when it is not a number. */
export function parseFactor(text: string): number | null {
  const n = text.trim() === "" ? NaN : Number(text);
  return Number.isFinite(n) ? n : null;
}

/** What the gauge needs of one assets/catalog.json model. */
export interface GaugeModel {
  id: string;
  category: string;
  name: string;
  /** Metres, [x, y, z]. */
  size: readonly number[];
}

const BUILDING_CATEGORIES = new Set(["buildings", "house", "preset_houses", "castle"]);
/** Which scale category a catalog model belongs to, or null when it has none (weapons, characters...). */
export function categorize(m: GaugeModel): ScaleCategory | null {
  const cat = m.category.toLowerCase();
  const name = m.name.toLowerCase();
  if (BUILDING_CATEGORIES.has(cat)) return "building";
  if (/(^|[_\s-])(tree|pine|oak|birch|spruce)/.test(name)) return "tree";
  if (cat === "rocks" || /rock|boulder|stone/.test(name)) return "rock";
  if (/bush|shrub|grass|flower|fern|plant|mushroom/.test(name)) return "plant";
  return null;
}

export type GaugeStatus = "ok" | "low" | "high" | "none";
export interface GaugeRow {
  category: ScaleCategory;
  count: number;
  /** Median scaled height, metres (0 when none). */
  typical: number;
  min: number;
  max: number;
  /** global x category: what the category's models are multiplied by before any per-asset correction. */
  factor: number;
  band: readonly [number, number] | null;
  status: GaugeStatus;
}
export interface Gauge {
  character: number;
  rows: GaugeRow[];
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Per category: the catalog models' heights after the current factors, and whether their typical size is sane. */
export function scaleGauge(models: readonly GaugeModel[], doc: ScaleDoc): Gauge {
  const heights = new Map<ScaleCategory, number[]>(SCALE_CATEGORIES.map((c) => [c, []]));
  for (const m of models) {
    const c = categorize(m);
    if (c !== null) heights.get(c)!.push(m.size[1] * resolveScale(doc, c, m.id));
  }
  const rows: GaugeRow[] = [];
  for (const category of SCALE_CATEGORIES) {
    const hs = heights.get(category)!;
    const band = BANDS[category] ?? null;
    if (hs.length === 0 && band === null) continue; // prop: nothing to judge
    const typical = hs.length > 0 ? median(hs) : 0;
    rows.push({
      category,
      count: hs.length,
      typical,
      min: hs.length > 0 ? Math.min(...hs) : 0,
      max: hs.length > 0 ? Math.max(...hs) : 0,
      factor: resolveScale(doc, category),
      band,
      status: hs.length === 0 || band === null ? "none" : typical < band[0] ? "low" : typical > band[1] ? "high" : "ok",
    });
  }
  return { character: CHARACTER_HEIGHT, rows };
}

export interface GaugeItem {
  category: ScaleCategory;
  status: GaugeStatus;
  /** Where the character stands and where the box is centred, metres from the left edge of the frame. */
  characterX: number;
  boxX: number;
  /** The box's footprint and its height (the category's typical size). */
  width: number;
  height: number;
}
export interface GaugeLayout {
  items: GaugeItem[];
  /** The frame, metres: x from 0 to `right`, y from 0 (ground) to `top`. */
  right: number;
  top: number;
}

/** Where the preview draws each category that has models: a 1.8 m character, then a box of the typical height beside it. */
export function gaugeLayout(gauge: Gauge): GaugeLayout {
  const items: GaugeItem[] = [];
  let cursor = 0.5;
  let top = gauge.character;
  for (const r of gauge.rows) {
    if (r.count === 0) continue;
    const width = Math.min(Math.max(r.typical * 0.6, 0.6), 12);
    items.push({ category: r.category, status: r.status, characterX: cursor + 0.4, boxX: cursor + 1 + width / 2, width, height: r.typical });
    cursor += 1 + width + 1.5;
    top = Math.max(top, r.typical);
  }
  return { items, right: Math.max(cursor, 4), top: top * 1.1 };
}
