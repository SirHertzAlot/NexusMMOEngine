/**
 * Character record view (roadmap E10) — read-only gathering of one
 * account's character for the editor's character record panel.
 *
 * The editor shows a character's name, look (canonical JSON, summarized),
 * deaths, saved state (`character_state` in characters.db) and its items
 * (the item ledger `item_events` in world.db: bag/held/ground rows with
 * the definition name from the loot pool, plus durability).
 *
 * READ-ONLY BY CONSTRUCTION: every query here is a SELECT. Callers open
 * both databases with `{ readonly: true }`; this module never prepares an
 * INSERT, UPDATE or DELETE, so it cannot write even against a writable
 * handle. It takes open `better-sqlite3` handles (never paths), so tests
 * can pass in-memory or temp databases.
 */

import type Database from "better-sqlite3";
import { parseLook } from "@mmo-engine/art/character";
import { LedgerKind } from "../persist/item-ledger.js";

/** One entry of the account → character picker. */
export interface CharacterListEntry {
  id: number;
  username: string;
  name: string;
}

/** A character's look, summarized for display alongside the raw JSON. */
export interface LookSummary {
  /** "male" / "female", or "unknown" when the stored JSON isn't a look. */
  gender: string;
  parts: Array<{ slot: string; name: string }>;
  colours: Array<{ slot: string; value: string }>;
  /** False when the stored JSON didn't parse (the raw JSON is still shown). */
  ok: boolean;
}

/** One recorded death, oldest first. */
export interface DeathView {
  at: number;
  x: number;
  z: number;
  /** The killer's character id, or null (creature, bot, nothing). */
  killer: number | null;
}

/** The last saved position and vitals, or null (never saved). */
export interface SavedStateView {
  x: number;
  y: number;
  z: number;
  health: number;
  stamina: number;
}

/** Where a ledger row says the item is. */
export type CharacterItemWhere = "bag" | "held" | "ground" | "created";

/** One of the character's items, as of its latest ledger event. */
export interface CharacterItemView {
  id: number;
  where: CharacterItemWhere;
  /** Bag slot or hand index; 0 for ground/created rows. */
  slot: number;
  /** Definition index into the loot pool. */
  def: number;
  /** Definition name from the loot pool, or `def <n>` when unknown. */
  name: string;
  rank: string;
  durability: number;
  /** Ground position (ground rows only; 0 otherwise). */
  x: number;
  z: number;
}

/** The whole read-only record the editor shows for one character. */
export interface CharacterView {
  id: number;
  username: string;
  name: string;
  createdAt: number;
  /** Canonical look JSON, exactly as stored. */
  lookJson: string;
  look: LookSummary;
  deaths: DeathView[];
  state: SavedStateView | null;
  items: CharacterItemView[];
}

/**
 * Definition names for the ledger's `def` column. `ItemDefs` satisfies
 * this structurally; the editor builds a lighter table from pool.jsonl
 * (names/ranks/colours only, no rules needed). Null: `def <n>` placeholders.
 */
export interface ItemDefNames {
  readonly count: number;
  readonly names: readonly string[];
  readonly ranks: readonly string[];
  readonly colors: readonly string[];
}

/** A character's look reduced to gender + chosen parts + colours. */
export function summarizeLook(lookJson: string): LookSummary {
  const look = parseLook(lookJson);
  if (!look) return { gender: "unknown", parts: [], colours: [], ok: false };
  return {
    gender: look.gender,
    parts: Object.entries(look.parts ?? {})
      .filter((e): e is [string, string] => typeof e[1] === "string")
      .map(([slot, name]) => ({ slot, name })),
    colours: Object.entries(look.colours ?? {}).map(([slot, value]) => ({
      slot,
      value: String(value),
    })),
    ok: true,
  };
}

/**
 * The characters of one account (oldest first), or every character when
 * `username` is omitted (the editor's picker groups by account). SELECT only.
 */
export function listCharacters(charsDb: Database.Database, username?: string): CharacterListEntry[] {
  if (username === undefined) {
    return charsDb
      .prepare("SELECT id, username, name FROM characters ORDER BY username, id")
      .all() as CharacterListEntry[];
  }
  return charsDb
    .prepare("SELECT id, username, name FROM characters WHERE username = ? ORDER BY id")
    .all(username) as CharacterListEntry[];
}

export interface ReadCharacterViewOptions {
  /** Open handle on world.db (read-only); omitted: no items, but the rest still loads. */
  worldDb?: Database.Database | null;
  /** Definition names for item rows; omitted: `def <n>` placeholders. */
  defs?: ItemDefNames | null;
}

/**
 * One account's character with its deaths, saved state and items, or null
 * when that account has no such character. Every query is a SELECT.
 */
export function readCharacterView(
  charsDb: Database.Database,
  username: string,
  id: number,
  opts: ReadCharacterViewOptions = {},
): CharacterView | null {
  const row = charsDb
    .prepare("SELECT id, username, name, look, created_at FROM characters WHERE id = ? AND username = ?")
    .get(id, username) as
    | { id: number; username: string; name: string; look: string; created_at: number }
    | undefined;
  if (!row) return null;

  const deaths = charsDb
    .prepare("SELECT at, x, z, killer FROM deaths WHERE character_id = ? ORDER BY at")
    .all(id) as DeathView[];

  const state =
    (charsDb
      .prepare("SELECT x, y, z, health, stamina FROM character_state WHERE character_id = ?")
      .get(id) as SavedStateView | undefined) ?? null;

  return {
    id: row.id,
    username: row.username,
    name: row.name,
    createdAt: row.created_at,
    lookJson: row.look,
    look: summarizeLook(row.look),
    deaths,
    state,
    items: opts.worldDb ? readCharacterItems(opts.worldDb, id, opts.defs ?? null) : [],
  };
}

/** Latest ledger event per item owned by `characterId` (tombstones excluded). SELECT only. */
function readCharacterItems(
  worldDb: Database.Database,
  characterId: number,
  defs: ItemDefNames | null,
): CharacterItemView[] {
  const rows = worldDb
    .prepare(
      `SELECT item_id AS id, kind, def, owner, slot, durability, x, z FROM item_events e
       WHERE kind != ${LedgerKind.Destroy}
         AND owner = ?
         AND seq = (SELECT MAX(seq) FROM item_events WHERE item_id = e.item_id)
       ORDER BY item_id`,
    )
    .all(characterId) as Array<{
    id: number;
    kind: number;
    def: number;
    owner: number;
    slot: number;
    durability: number;
    x: number;
    z: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    where: whereName(r.kind),
    slot: r.slot,
    def: r.def,
    name: defs && r.def >= 0 && r.def < defs.count ? defs.names[r.def] : `def ${r.def}`,
    rank: defs && r.def >= 0 && r.def < defs.count ? defs.ranks[r.def] : "",
    durability: Math.round(r.durability),
    x: r.x,
    z: r.z,
  }));
}

function whereName(kind: number): CharacterItemWhere {
  if (kind === LedgerKind.Bag) return "bag";
  if (kind === LedgerKind.Hold) return "held";
  if (kind === LedgerKind.Ground) return "ground";
  return "created";
}
