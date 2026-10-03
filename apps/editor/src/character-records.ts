/**
 * Browser-safe character-record adapter for the editor UI.
 *
 * Like server-control.ts, this module only speaks HTTP to the dev-host
 * routes (`GET /api/editor/characters`), so the character record panel
 * can import it safely. The dev host opens characters.db and world.db
 * read-only; nothing here (or there) writes.
 */

/** One entry of the account → character picker. */
export interface CharacterListEntry {
  id: number;
  username: string;
  name: string;
}

export interface LookSummary {
  gender: string;
  parts: Array<{ slot: string; name: string }>;
  colours: Array<{ slot: string; value: string }>;
  ok: boolean;
}

export interface DeathView {
  at: number;
  x: number;
  z: number;
  killer: number | null;
}

export interface SavedStateView {
  x: number;
  y: number;
  z: number;
  health: number;
  stamina: number;
}

export type CharacterItemWhere = "bag" | "held" | "ground" | "created";

export interface CharacterItemView {
  id: number;
  where: CharacterItemWhere;
  slot: number;
  def: number;
  name: string;
  rank: string;
  durability: number;
  x: number;
  z: number;
}

/** The whole read-only record the panel shows for one character. */
export interface CharacterView {
  id: number;
  username: string;
  name: string;
  createdAt: number;
  lookJson: string;
  look: LookSummary;
  deaths: DeathView[];
  state: SavedStateView | null;
  items: CharacterItemView[];
}

async function readError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return new Error(body.error);
  } catch {
    /* fall through to the fallback */
  }
  return new Error(`${fallback}: HTTP ${res.status}`);
}

/** The account's characters (or every character when `username` is empty). */
export async function listCharacterRecords(
  base = "",
  username?: string,
): Promise<{ characters: CharacterListEntry[]; hasDb: boolean }> {
  const q = username ? `?username=${encodeURIComponent(username)}` : "";
  const res = await fetch(`${base}/api/editor/characters${q}`);
  if (!res.ok) throw await readError(res, "character list failed");
  const body = (await res.json()) as { characters?: CharacterListEntry[]; hasDb?: boolean };
  return { characters: body.characters ?? [], hasDb: body.hasDb ?? true };
}

/** One account's character with deaths, saved state and items. */
export async function getCharacterRecord(
  base = "",
  username: string,
  id: number,
): Promise<{ view: CharacterView; defsResolved: boolean; hasWorldDb: boolean }> {
  const res = await fetch(
    `${base}/api/editor/characters/${id}?username=${encodeURIComponent(username)}`,
  );
  if (!res.ok) throw await readError(res, "character record failed");
  const body = (await res.json()) as {
    view: CharacterView;
    defsResolved?: boolean;
    hasWorldDb?: boolean;
  };
  return {
    view: body.view,
    defsResolved: body.defsResolved ?? false,
    hasWorldDb: body.hasWorldDb ?? false,
  };
}
