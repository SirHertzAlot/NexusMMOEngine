/**
 * The VS Code handoff on the editor dev host (slice EU9). Loopback
 * routes, wired in host.ts:
 *
 *   GET  /api/editor/code         → { ok, repoRoot, editor: { command, found, version } }
 *   POST /api/editor/code/open    → { source } or { path, line? }: spawn `code -g <abs>:<line>`
 *
 * The host does only what the browser cannot: tell whether `code` is on
 * this machine's PATH, and start it. Everything about WHICH paths may be
 * opened lives in `code-handoff.ts` and is applied here as well as in
 * the button, so the rule cannot hold in one place and not the other —
 * in particular `assets/`, which `vcs-host.ts` refuses for the same
 * reason.
 *
 * Nothing is ever passed to a shell: the child is spawned with an argv
 * array, so a path can hold whatever characters it likes without
 * becoming a command. The resolved file must sit inside the repository
 * and must exist; a refused request starts no process.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { codeCommand, parseSourceRef, refuseOpen, type SourceRef } from "./code-handoff.js";
import { failureReply, type RouteReply } from "./api.js";

export interface EditorProbe {
  /** The command we look for. */
  command: string;
  found: boolean;
  /** First line of `code --version`, when it answered. */
  version: string | null;
}

export interface CodeHostDeps {
  /** Is `code` on PATH, and which version. Probed once per host. */
  probe: () => Promise<EditorProbe>;
  /** Start the editor. Rejects when the process could not be started. */
  open: (args: readonly string[]) => Promise<void>;
}

/** `code --version` prints version, commit, arch on three lines. */
export const probeVsCode = (): Promise<EditorProbe> =>
  new Promise((done) => {
    execFile("code", ["--version"], { timeout: 4000 }, (err, stdout) => {
      if (err) done({ command: "code", found: false, version: null });
      else done({ command: "code", found: true, version: stdout.split(/\r?\n/)[0]?.trim() || null });
    });
  });

/**
 * Start VS Code detached, so closing the editor's dev server does not
 * take the person's editor with it, and so a long-lived child is not
 * left attached to this process's stdio.
 */
export const openVsCode = (args: readonly string[]): Promise<void> =>
  new Promise((done, fail) => {
    const child = spawn("code", [...args], { detached: true, stdio: "ignore" });
    child.once("error", fail);
    child.once("spawn", () => {
      child.unref();
      done();
    });
  });

const defaults: CodeHostDeps = { probe: probeVsCode, open: openVsCode };

/** The absolute file for a reference, or an explanation it cannot have one. */
export function resolveRef(repoRoot: string, ref: SourceRef): { file: string } | { error: string } {
  const refusal = refuseOpen(ref.relPath);
  if (refusal !== null) return { error: refusal };
  const root = resolve(repoRoot);
  const file = resolve(join(root, ref.relPath));
  // Belt and braces: `refuseOpen` already rejects `..` and absolute paths,
  // but a symlinked segment or a case-insensitive trick should not slip past.
  const rel = relative(root, file);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
    return { error: `"${ref.relPath}": resolves outside the repository` };
  }
  if (!existsSync(file)) return { error: `"${ref.relPath}": no such file in this checkout` };
  return { file };
}

/** The argv for `code`: `-g <file>:<line>` opens at the line, `<file>` alone opens the file. */
export const codeArgs = (file: string, line: number | null): string[] =>
  line === null ? [file] : ["-g", `${file}:${line}`];

const NOT_FOUND =
  "VS Code was not found on this machine's PATH. Install it, or run \"Shell Command: Install 'code' command in PATH\" from inside VS Code, then try again.";

/** A reference from `{ source }` ("file:line") or `{ path, line }`. */
export function refFromBody(body: unknown): SourceRef | null {
  const b = (body ?? {}) as { source?: unknown; path?: unknown; line?: unknown };
  if (typeof b.source === "string") return parseSourceRef(b.source);
  if (typeof b.path !== "string") return null;
  const line = typeof b.line === "number" && Number.isInteger(b.line) && b.line >= 1 ? b.line : null;
  const ref = parseSourceRef(b.path);
  return ref === null ? null : { relPath: ref.relPath, line: line ?? ref.line };
}

let cached: Promise<EditorProbe> | null = null;

/** Forget the probe, so a freshly installed `code` is found without a restart. */
export const forgetEditorProbe = (): void => {
  cached = null;
};

export async function handleCodeRoute(
  repoRoot: string,
  method: string,
  pathname: string,
  body: string | undefined,
  deps: CodeHostDeps = defaults,
): Promise<RouteReply | null> {
  if (pathname !== "/api/editor/code" && !pathname.startsWith("/api/editor/code/")) return null;
  const probe = (): Promise<EditorProbe> => (cached ??= deps.probe());
  try {
    if (method === "GET" && pathname === "/api/editor/code") {
      return { status: 200, body: { ok: true, repoRoot: resolve(repoRoot), editor: await probe() } };
    }
    if (method === "POST" && pathname === "/api/editor/code/open") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? "{}");
      } catch {
        return { status: 400, body: { ok: false, error: "body must be JSON" } };
      }
      const ref = refFromBody(parsed);
      if (ref === null) return { status: 400, body: { ok: false, error: "expected { source } or { path, line? }" } };
      const target = resolveRef(repoRoot, ref);
      if ("error" in target) return { status: 400, body: { ok: false, error: target.error } };
      const editor = await probe();
      if (!editor.found) return { status: 409, body: { ok: false, error: NOT_FOUND, command: codeCommand(ref) } };
      await deps.open(codeArgs(target.file, ref.line));
      return { status: 200, body: { ok: true, opened: ref.line === null ? ref.relPath : `${ref.relPath}:${ref.line}` } };
    }
    return { status: 404, body: { ok: false, error: "not found" } };
  } catch (err) {
    return failureReply(err);
  }
}
