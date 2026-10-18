/**
 * The designer settings documents the editor edits as forms, each one
 * fixed file under `<repo>/content` (content-docs-host.ts validates and
 * writes them), and the browser-safe HTTP adapter over their routes.
 */

import { callEnvelope, IssuesError, invalidMessage } from "./api.js";
import type { RulesIssue } from "./rules-control.js";

export const CONTENT_DOC_FILES = {
  /** Dungeon runs (D4): party size, time limit, traps, chests, loot rolls. */
  instances: "dungeons/instances.json",
  /** Where in the open world a party asks for a dungeon. */
  entrances: "dungeons/entrances.json",
  /** Crafting rules (units, fittings, reagents fallback, rune stone, skills); refining and reagents stay in the Data grids. */
  crafting: "crafting/recipes.json",
} as const;

export type ContentDocName = keyof typeof CONTENT_DOC_FILES;

export const isContentDoc = (name: string): name is ContentDocName => Object.hasOwn(CONTENT_DOC_FILES, name);

export class ContentDocSaveError extends IssuesError<RulesIssue> {
  constructor(name: string, issues: RulesIssue[]) {
    super(issues, invalidMessage(name, issues.length));
  }
}

export const getContentDoc = async (name: ContentDocName, base = ""): Promise<unknown> =>
  (await callEnvelope<{ content: unknown }>(`${base}/api/editor/docs/${name}`, "GET")).content;

/** Validate on the host and write only when valid; throws ContentDocSaveError with every issue otherwise. */
export const saveContentDoc = async (name: ContentDocName, content: unknown, base = ""): Promise<void> => {
  await callEnvelope<unknown>(`${base}/api/editor/docs/${name}`, "PUT", { content }, (i: RulesIssue[]) => new ContentDocSaveError(name, i));
};
