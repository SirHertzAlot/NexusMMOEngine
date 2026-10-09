/**
 * Browser-safe adapter for the Gameplay grids and the content browser: HTTP
 * to the dev host's /api/editor/gameplay and /api/editor/content-catalog
 * routes (gameplay-host.ts, content-catalog.ts). A refused save comes back as
 * GameplaySaveError with every issue and nothing written.
 */

import type { GameplayTable } from "./gameplay-tables.js";
import type { CatalogEntry } from "./content-catalog-types.js";

export interface GameplayIssue {
  file: string;
  path: string;
  message: string;
}

export interface GameplaySnapshot {
  tables: Record<GameplayTable, unknown>;
  context: {
    refs: { items: string[]; creatures: string[] };
    options: { techniques: string[]; families: string[] };
    builtinSpecies: string[];
  };
}

export class GameplaySaveError extends Error {
  constructor(readonly issues: GameplayIssue[]) {
    super(`refused: ${issues.length} problem${issues.length === 1 ? "" : "s"}`);
    this.name = "GameplaySaveError";
  }
}

async function failure(res: Response, what: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: string; issues?: GameplayIssue[] };
    if (res.status === 400 && Array.isArray(body.issues)) return new GameplaySaveError(body.issues);
    if (body.error) return new Error(body.error);
  } catch {
    /* fall through */
  }
  return new Error(`${what}: HTTP ${res.status}`);
}

const send = (url: string, method: string, body: unknown): Promise<Response> =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export async function loadGameplay(base = ""): Promise<GameplaySnapshot> {
  const res = await fetch(`${base}/api/editor/gameplay`);
  if (!res.ok) throw await failure(res, "gameplay load failed");
  return (await res.json()) as GameplaySnapshot;
}

/** Validate a candidate on the host (the server's own loaders); nothing is written. */
export async function checkGameplayRemote(table: GameplayTable, content: unknown, base = ""): Promise<GameplayIssue[]> {
  const res = await send(`${base}/api/editor/gameplay/check`, "POST", { table, content });
  if (!res.ok) throw await failure(res, "gameplay check failed");
  return ((await res.json()) as { issues: GameplayIssue[] }).issues;
}

/** Save one table's file; throws GameplaySaveError when the server would refuse it. */
export async function saveGameplayRemote(table: GameplayTable, content: unknown, base = ""): Promise<void> {
  const res = await send(`${base}/api/editor/gameplay/${table}`, "PUT", { content });
  if (!res.ok) throw await failure(res, "gameplay save failed");
}

export async function loadCatalog(base = ""): Promise<{ entries: CatalogEntry[]; notes: string[] }> {
  const res = await fetch(`${base}/api/editor/content-catalog`);
  if (!res.ok) throw await failure(res, "content catalog failed");
  return (await res.json()) as { entries: CatalogEntry[]; notes: string[] };
}
