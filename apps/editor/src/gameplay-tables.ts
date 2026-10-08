/**
 * The Gameplay grids' table definitions (roadmap EA15): which files the grids
 * edit, how a file becomes rows and back, and which columns a row shows.
 *
 * Browser-safe. Everything here is the shape of a file the server really
 * loads (content/rules/*.json through `loadRules`; the species overlay through
 * `loadSpecies`), so a grid can only write what those loaders accept, and the
 * columns the grid doesn't show survive a save untouched.
 */

import { CREATURE_FIELDS, ITEM_BASE_FIELDS, newEntry, type FieldSpec } from "./rules-control.js";
import type { GridColumn, GridContext, GridRow } from "./gameplay-grid.js";

export const GAMEPLAY_TABLES = ["creatures", "items", "skills", "spells", "species"] as const;
export type GameplayTable = (typeof GAMEPLAY_TABLES)[number];

export const isGameplayTable = (v: unknown): v is GameplayTable => typeof v === "string" && (GAMEPLAY_TABLES as readonly string[]).includes(v);

export interface TableDef {
  id: GameplayTable;
  label: string;
  noun: string;
  /** Where the file lives, for the status line. */
  file: string;
  /** Key of the collection inside the file's JSON. */
  under: string;
  /** Entries keyed by id (record) or listed with an `id` field (array). */
  shape: "record" | "array";
  idPattern: RegExp;
  columns: GridColumn[];
  /** A new row's starting values. */
  newData(ctx: GridContext): Record<string, unknown>;
}

const col = (f: FieldSpec, extra: Partial<GridColumn> = {}): GridColumn => ({ ...f, ...extra }) as GridColumn;
const share = { kind: "number", min: 0, max: 1 } as const;
const RULES_ID = /^[a-z][a-zA-Z0-9-]*$/;

const creatureNested = new Set(["weapons", "chaseSpeed", "attackEverySeconds"]);
const itemNested = new Set(["models"]);

export const TABLE_DEFS: Record<GameplayTable, TableDef> = {
  creatures: {
    id: "creatures",
    label: "Creatures",
    noun: "creature",
    file: "content/rules/creatures.json",
    under: "creatures",
    shape: "record",
    idPattern: RULES_ID,
    columns: [
      ...CREATURE_FIELDS.map((f) => col(f, { nested: creatureNested.has(f.key), ...(f.key === "weapons" ? { ref: "items" } : {}) })),
      { key: "drops.rolls", label: "Drop rolls", kind: "pair", def: [1, 2], nested: true },
      { key: "drops.chance", label: "Drop chance", ...share, def: 0.8, nested: true },
    ],
    newData: (ctx) => newEntry("creatures", [...(ctx.refs.items ?? [])]),
  },
  items: {
    id: "items",
    label: "Item bases",
    noun: "item base",
    file: "content/rules/items.json",
    under: "bases",
    shape: "record",
    idPattern: RULES_ID,
    columns: ITEM_BASE_FIELDS.map((f) => col(f, { nested: itemNested.has(f.key) })),
    newData: () => newEntry("items", []),
  },
  skills: {
    id: "skills",
    label: "Skills",
    noun: "skill",
    file: "content/rules/skills.json",
    under: "skills",
    shape: "array",
    idPattern: RULES_ID,
    columns: [
      { key: "name", label: "Name", kind: "text" },
      { key: "family", label: "Family", kind: "enum", options: [], optionsFrom: "families" },
      { key: "related", label: "Related skills (id: share)", kind: "json", nested: true },
    ],
    newData: (ctx) => ({ name: "New skill", family: ctx.options.families?.[0] ?? "weapon" }),
  },
  spells: {
    id: "spells",
    label: "Spells",
    noun: "spell",
    file: "content/rules/spells.json",
    under: "spells",
    shape: "array",
    idPattern: RULES_ID,
    columns: [
      { key: "name", label: "Name", kind: "text" },
      { key: "mana", label: "Mana", kind: "number", min: 0 },
      { key: "castSeconds", label: "Cast (s)", kind: "number", min: 0, def: 1.5 },
      { key: "cooldownSeconds", label: "Cooldown (s)", kind: "number", min: 0, def: 0 },
      { key: "target", label: "Target", kind: "enum", options: ["self", "any"], def: "any" },
      { key: "reach", label: "Reach (m)", kind: "number", min: 0, def: 3 },
      { key: "effect", label: "Effect", kind: "json", nested: true },
    ],
    newData: () => ({ name: "New spell", mana: 10, effect: { kind: "heal", amount: 10 } }),
  },
  species: {
    id: "species",
    label: "Species",
    noun: "species",
    file: "content/species/species.json (over the built-in roster)",
    under: "species",
    shape: "record",
    idPattern: /^[a-z][a-z0-9-]*$/,
    columns: [
      { key: "name", label: "Name", kind: "text" },
      { key: "kind", label: "Kind", kind: "enum", options: ["organic", "beast", "undead", "demon", "otherworldly"] },
      { key: "sustenance", label: "Sustenance", kind: "list" },
      { key: "pack", label: "Pack", kind: "pair", def: [1, 1] },
      { key: "tier", label: "Tier (1-3)", kind: "pair", def: [1, 3] },
      { key: "boss", label: "Boss", kind: "bool", def: false },
      { key: "minRank", label: "Min rank", kind: "number", int: true, min: 1, def: 1 },
      { key: "body", label: "Body plan", kind: "text", def: "humanoid" },
      { key: "tags", label: "Tags", kind: "list", nested: true },
      { key: "habitat", label: "Habitat (biomes, dungeon themes)", kind: "json", nested: true },
      { key: "drawnTo", label: "Drawn to (room archetypes)", kind: "json", nested: true },
    ],
    newData: () => ({ name: "New species", kind: "organic", sustenance: ["food"] }),
  },
};

// ------------------------------------------------------------ file <-> rows

export function toRows(def: TableDef, json: unknown): GridRow[] {
  const at = (json as Record<string, unknown> | null)?.[def.under];
  if (def.shape === "array") {
    return (Array.isArray(at) ? at : []).map((e) => {
      const { id, ...data } = e as Record<string, unknown>;
      return { id: String(id), data };
    });
  }
  return Object.entries((at ?? {}) as Record<string, Record<string, unknown>>).map(([id, data]) => ({ id, data }));
}

/** `json` with the collection replaced by `rows` (everything else in the file kept). */
export function fromRows(def: TableDef, json: unknown, rows: readonly GridRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...((json as Record<string, unknown> | null) ?? {}) };
  out[def.under] = def.shape === "array" ? rows.map((r) => ({ id: r.id, ...r.data })) : Object.fromEntries(rows.map((r) => [r.id, r.data]));
  return out;
}

/** The row and column a server issue path (`creatures.goblin.weapons[0]`, `skills[1].family`) is about. */
export function cellOfIssue(def: TableDef, path: string, rows: readonly GridRow[]): { rowId: string; key: string } | null {
  let rowId: string;
  let rest: string;
  if (def.shape === "array") {
    const m = new RegExp(`^${def.under}\\[(\\d+)\\]\\.?(.*)$`).exec(path);
    if (!m || !rows[Number(m[1])]) return null;
    [rowId, rest] = [rows[Number(m[1])].id, m[2]];
  } else {
    const m = new RegExp(`^${def.under}\\.([^.[]+)\\.?(.*)$`).exec(path);
    if (!m) return null;
    [rowId, rest] = [m[1], m[2]];
  }
  const bare = rest.replace(/\[\d+\]/g, "");
  const key = def.columns.map((c) => c.key).filter((k) => bare === k || bare.startsWith(`${k}.`)).sort((a, b) => b.length - a.length)[0] ?? bare;
  return { rowId, key };
}
