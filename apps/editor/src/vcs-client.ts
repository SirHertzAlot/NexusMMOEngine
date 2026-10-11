/** Browser-safe adapter for the dev host's `/api/editor/vcs` routes (see vcs-host.ts). */
import { callEnvelope } from "./api.js";

export interface VcsFile {
  path: string;
  docType: string;
  status: string;
  staged: boolean;
  conflicted: boolean;
  localOnly?: boolean;
}
export interface VcsDiff {
  mode: "semantic" | "text";
  summary?: string[];
  text?: string;
}
export interface VcsConflict {
  path: string;
  ours?: unknown;
  theirs?: unknown;
}

const call = <T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> => callEnvelope<T>(`/api/editor/vcs/${route}`, method, body);

export const vcsStatus = (): Promise<{ branch: string; files: VcsFile[] }> => call("GET", "status");
export const vcsDiff = (path: string): Promise<VcsDiff> => call("GET", `diff?path=${encodeURIComponent(path)}`);
export const vcsLog = (): Promise<{ commits: Array<{ hash: string; subject: string; author: string }> }> => call("GET", "log");
export const vcsStage = (paths: string[]): Promise<unknown> => call("POST", "stage", { paths });
export const vcsUnstage = (paths: string[]): Promise<unknown> => call("POST", "unstage", { paths });
export const vcsCommit = (message: string): Promise<unknown> => call("POST", "commit", { message });
export const vcsSync = (what: "pull" | "push"): Promise<unknown> => call("POST", what, { confirm: true });
export const vcsResolve = (path: string, choices?: Record<string, "ours" | "theirs">): Promise<{ resolved: boolean; conflicts?: VcsConflict[] }> =>
  call("POST", "resolve", { path, choices });
export const vcsLocks = (): Promise<{ locks: Record<string, { owner: string; since: string }> }> => call("GET", "locks");
