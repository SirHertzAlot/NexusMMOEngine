/**
 * Browser-safe adapter for the Gameplay grids and the content browser: HTTP
 * to the dev host's /api/editor/gameplay and /api/editor/content-catalog
 * routes (gameplay-host.ts, content-catalog.ts). A refused save comes back as
 * GameplaySaveError with every issue and nothing written.
 */

import { IssuesError, invalidMessage, requestJson } from "./api.js";
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
    refs: { items: string[]; creatures: string[]; materials: string[]; prefabs: string[] };
    options: { techniques: string[]; families: string[]; nodeKinds: string[]; lootTables: string[]; materials: string[] };
    builtinSpecies: string[];
  };
}

export class GameplaySaveError extends IssuesError<GameplayIssue> {
  constructor(issues: GameplayIssue[]) {
    super(issues, invalidMessage("gameplay", issues.length));
  }
}

const refused = (issues: GameplayIssue[]): Error => new GameplaySaveError(issues);

export const loadGameplay = (base = ""): Promise<GameplaySnapshot> =>
  requestJson(`${base}/api/editor/gameplay`, { fail: "gameplay load failed", refused });

/** One species of the wildlife table, as the read-only view shows it (the host's WildlifeRow). */
export interface WildlifeSpecies {
  id: string;
  role: string;
  habitat: string;
  temperament: string;
  activity: string;
  tier: number;
  health: number;
  noticeM: number;
  territoryM: number;
  wanderM: number;
  group: string;
  groupMin: number;
  groupMax: number;
  raidRangeM: number | null;
  biomes: string[];
  boss: boolean;
}

export interface WildlifeView {
  species: WildlifeSpecies[];
  problems: string[];
  biomes: string[];
}

/** The wildlife table as the server loads it, with the table's own checks. Read only. */
export const loadWildlife = (base = ""): Promise<WildlifeView> =>
  requestJson(`${base}/api/editor/gameplay/wildlife`, { fail: "wildlife load failed" });

/** Validate a candidate on the host (the server's own loaders); nothing is written. */
export async function checkGameplayRemote(table: GameplayTable, content: unknown, base = ""): Promise<GameplayIssue[]> {
  return (await requestJson<{ issues: GameplayIssue[] }>(`${base}/api/editor/gameplay/check`, { body: { table, content }, fail: "gameplay check failed", refused })).issues;
}

/** Save one table's file; throws GameplaySaveError when the server would refuse it. */
export const saveGameplayRemote = (table: GameplayTable, content: unknown, base = ""): Promise<void> =>
  requestJson(`${base}/api/editor/gameplay/${table}`, { method: "PUT", body: { content }, fail: "gameplay save failed", refused });

export const loadCatalog = (base = ""): Promise<{ entries: CatalogEntry[]; notes: string[] }> =>
  requestJson(`${base}/api/editor/content-catalog`, { fail: "content catalog failed", refused });
