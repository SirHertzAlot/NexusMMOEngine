/**
 * The game manifest over HTTP (roadmap EB10): one route family,
 * `/api/editor/game`, read and written by the Game panel.
 *
 * Browser-safe. Nothing here decides anything about a manifest — the
 * host validates with the SDK's schema and this carries the refusal
 * through with its issues, the way the other editor clients do.
 */

import { IssuesError, invalidMessage, requestJson } from "./api.js";
import type { RulesIssue } from "./rules-control.js";

/** One setting a module declares in its `module.json` (EB10). */
export interface SettingInfo {
  key: string;
  type: "number" | "string" | "boolean" | "enum";
  default?: number | string | boolean;
  label?: string;
  help?: string;
  options?: string[];
  min?: number;
  max?: number;
  int?: boolean;
}

export interface ModuleSettingsInfo {
  module: string;
  enabled: boolean;
  settings: SettingInfo[];
  /** Keys this game sets that the module never declared. */
  undeclared: string[];
}

export interface GameState {
  /** False when the game has no `game.json` at all, which is the engine's own case. */
  exists: boolean;
  /** Where the manifest is, or would be. */
  file: string;
  manifest: Record<string, unknown> | null;
  modules: ModuleSettingsInfo[];
  /** Set when the file is there and unreadable, so the panel says so rather than offering to create one. */
  error?: string;
}

export class ManifestSaveError extends IssuesError<RulesIssue> {
  constructor(issues: RulesIssue[]) {
    super(issues, invalidMessage("game.json", issues.length));
  }
}

const refuse = (issues: RulesIssue[]): ManifestSaveError => new ManifestSaveError(issues);

export const loadGame = (base = ""): Promise<GameState> =>
  requestJson<GameState>(`${base}/api/editor/game`, { fail: "could not read the game manifest" });

/** Write the first `game.json`. The host refuses if one is already there. */
export const createGame = (name: string, description: string, base = ""): Promise<GameState> =>
  requestJson<GameState>(`${base}/api/editor/game`, { method: "POST", body: { name, description }, fail: "could not create game.json", refused: refuse });

export const saveGame = (manifest: Record<string, unknown>, base = ""): Promise<GameState> =>
  requestJson<GameState>(`${base}/api/editor/game`, { method: "PUT", body: { manifest }, fail: "could not save game.json", refused: refuse });

/** The settings block of one module, as the manifest holds it. */
export const settingsOf = (manifest: Record<string, unknown> | null, module: string): Record<string, unknown> =>
  ((manifest?.modules as Record<string, Record<string, unknown>> | undefined)?.[module] ?? {}) as Record<string, unknown>;

/**
 * A manifest with one module setting changed. `undefined` removes the
 * key (the module's own default applies again), and a module left with
 * no settings drops out of `modules` entirely, so turning everything
 * back to its default leaves the file as it started rather than littered
 * with empty objects.
 */
export function withSetting(manifest: Record<string, unknown>, module: string, key: string, value: unknown): Record<string, unknown> {
  const modules = { ...((manifest.modules as Record<string, Record<string, unknown>>) ?? {}) };
  const own = { ...(modules[module] ?? {}) };
  if (value === undefined) delete own[key];
  else own[key] = value;
  if (Object.keys(own).length === 0) delete modules[module];
  else modules[module] = own;
  const next = { ...manifest };
  if (Object.keys(modules).length === 0) delete next.modules;
  else next.modules = modules;
  return next;
}
