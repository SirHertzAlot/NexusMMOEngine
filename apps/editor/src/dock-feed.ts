/**
 * What the bottom dock shows: the play server's log (polled from the host),
 * the bakes and regenerations run from the editor this session, and the
 * problems the open document reports (see doc-actions.ts).
 */

import { createStore } from "./store.js";

export interface ServerLogPage {
  lines: string[];
  /** Line number of lines[0]. */
  from: number;
  /** The number to ask for next. */
  next: number;
  running: boolean;
}

export async function fetchServerLog(since: number, base = ""): Promise<ServerLogPage> {
  const res = await fetch(`${base}/api/editor/server/log?since=${since}`);
  if (!res.ok) throw new Error(`server log failed: HTTP ${res.status}`);
  return (await res.json()) as ServerLogPage;
}

/** Keep at most `max` lines, newest last. */
export function appendLines(lines: string[], more: string[], max = 500): string[] {
  const all = lines.concat(more);
  return all.length > max ? all.slice(all.length - max) : all;
}

export type LogTone = "error" | "warn" | "info";

/** Colour class for a server log line: errors and warnings by their words, the editor's own lines apart. */
export function lineTone(line: string): LogTone {
  if (/\b(error|fatal|exception|uncaught|failed)\b/i.test(line)) return "error";
  if (/\bwarn(ing)?\b/i.test(line)) return "warn";
  return "info";
}

export interface BakeEntry {
  at: number;
  source: string;
  text: string;
  ok: boolean;
}

const bakes = createStore<readonly BakeEntry[]>([]);

/** Record a bake or regeneration the editor ran (shown in the Bakes tab). */
export function pushBake(source: string, text: string, ok = true): void {
  bakes.set((all) => [...all, { at: Date.now(), source, text, ok }].slice(-100));
}

export const getBakes = bakes.get;
export const subscribeBakes = bakes.subscribe;
