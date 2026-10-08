/**
 * Version control for the editor dev host (roadmap EA18): the git CLI
 * behind `/api/editor/vcs`, loopback like the other editor routes.
 *
 *   GET  status                → { branch, files: [{ path, docType, status, staged, localOnly, conflicted }] }
 *   GET  diff?path=            → semantic (id-keyed) diff for JSON documents, text diff otherwise
 *   GET  log                   → { commits }
 *   POST stage | unstage       → { paths }
 *   POST commit                → { message }
 *   POST pull | push           → { confirm: true } (refused without it)
 *   POST resolve               → { path, choices? } three-way JSON merge by stable ids of a conflicted document
 *   GET  locks, POST lock | unlock → advisory soft locks in content/locks.json
 *
 * Safety: git always runs from a fixed argument array (no shell) with cwd
 * at the repo root; every path is validated (relative, inside the repo,
 * a file, no pathspec magic) before it reaches git; and anything under
 * `assets/` (confidential licensed art) is never staged, diffed or
 * committed, whatever the .gitignore says. A refused request changes nothing.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { diffDocs, mergeDocs, summarize, type Json } from "./vcs-merge.js";

export interface VcsRouteResult {
  status: number;
  body: unknown;
}

const fail = (status: number, error: string, extra: object = {}): VcsRouteResult => ({ status, body: { ok: false, error, ...extra } });
const ok = (body: object = {}): VcsRouteResult => ({ status: 200, body: { ok: true, ...body } });

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git with a fixed argument array: no shell, cwd at the repo, never prompting. */
function git(repoRoot: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

// ---- paths ------------------------------------------------------------------

const ASSETS_MSG = "paths under assets/ are confidential licensed art and are never staged, diffed or committed";

/** Normalised repo-relative path, or a 400 with the reason. Never touches git. */
export function checkPath(repoRoot: string, raw: unknown): { path: string } | { error: string } {
  if (typeof raw !== "string" || raw === "" || raw.includes("\0")) return { error: "path must be a non-empty string" };
  const p = posix.normalize(raw.replace(/\\/g, "/"));
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p) || p.startsWith(":")) return { error: `"${raw}": path must be relative to the repo, with no pathspec magic` };
  if (p === "." || p === ".." || p.startsWith("../")) return { error: `"${raw}": path must name a file inside the repo` };
  // Windows ignores case and trailing dots/spaces, so compare the way the filesystem does.
  const first = p.split("/")[0].replace(/[. ]+$/, "").toLowerCase();
  if (first === "assets") return { error: `"${raw}": ${ASSETS_MSG}` };
  const abs = join(repoRoot, p);
  if (existsSync(abs) && statSync(abs).isDirectory()) return { error: `"${raw}": stage files, not directories` };
  return { path: p };
}

const isAssets = (p: string): boolean => p.split("/")[0].replace(/[. ]+$/, "").toLowerCase() === "assets";

function checkPaths(repoRoot: string, raw: unknown): { paths: string[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'need {"paths": [...]}' };
  const paths: string[] = [];
  for (const r of raw) {
    const c = checkPath(repoRoot, r);
    if ("error" in c) return c;
    paths.push(c.path);
  }
  return { paths };
}

export function docType(p: string): string {
  if (p.startsWith("content/scenes/")) return "scene";
  if (p === "content/quests/dialogs.json") return "dialog";
  if (p.startsWith("content/quests/")) return "quest";
  if (p.startsWith("content/rules/")) return "rules";
  if (p.startsWith("content/pcg/")) return "pcg";
  if (p.startsWith("content/dungeons/")) return "dungeon";
  if (p === "content/locks.json") return "locks";
  return "other";
}

// ---- status / diff / log ----------------------------------------------------------

const LABEL: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", "?": "untracked", U: "conflicted" };

async function unmerged(repoRoot: string): Promise<string[]> {
  return (await git(repoRoot, ["diff", "--name-only", "--diff-filter=U", "-z"])).stdout.split("\0").filter(Boolean);
}

async function status(repoRoot: string): Promise<VcsRouteResult> {
  const branch = (await git(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim() || "(detached)";
  const r = await git(repoRoot, ["status", "--porcelain=v1", "-z", "-uall"]);
  if (r.code !== 0) return fail(500, `git status failed: ${r.stderr.trim()}`);
  const parts = r.stdout.split("\0");
  const files: object[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const x = e[0];
    const y = e[1];
    const path = e.slice(3);
    if (x === "R" || x === "C") i++; // the original name follows
    const conflicted = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    const code = conflicted ? "U" : x === "?" ? "?" : y !== " " ? y : x;
    files.push({
      path,
      docType: docType(path),
      status: LABEL[code] ?? code,
      staged: !conflicted && x !== " " && x !== "?",
      conflicted,
      ...(isAssets(path) ? { localOnly: true } : {}),
    });
  }
  return ok({ branch, files });
}

const MAX_TEXT_DIFF = 200_000;

async function diff(repoRoot: string, rawPath: string | null): Promise<VcsRouteResult> {
  const c = checkPath(repoRoot, rawPath);
  if ("error" in c) return fail(400, c.error);
  const path = c.path;
  if (path.endsWith(".json")) {
    const head = await git(repoRoot, ["show", `HEAD:${path}`]);
    const abs = join(repoRoot, path);
    try {
      const before = head.code === 0 ? (JSON.parse(head.stdout) as Json) : undefined;
      const after = existsSync(abs) ? (JSON.parse(readFileSync(abs, "utf8")) as Json) : undefined;
      const changes = diffDocs(before, after);
      return ok({ path, docType: docType(path), mode: "semantic", changes, summary: summarize(changes) });
    } catch {
      /* not valid JSON on one side: fall back to the text diff */
    }
  }
  const t = await git(repoRoot, ["diff", "HEAD", "--no-color", "--", path]);
  return ok({ path, docType: docType(path), mode: "text", text: t.stdout.slice(0, MAX_TEXT_DIFF) });
}

async function log(repoRoot: string): Promise<VcsRouteResult> {
  const r = await git(repoRoot, ["log", "-n", "30", "--format=%H%x1f%an%x1f%aI%x1f%s"]);
  const commits = r.code === 0 ? r.stdout.split("\n").filter(Boolean).map((l) => {
    const [hash, author, date, subject] = l.split("\x1f");
    return { hash, author, date, subject };
  }) : []; // no commits yet
  return ok({ commits });
}

// ---- stage / commit / pull / push -------------------------------------------------

async function commit(repoRoot: string, message: unknown): Promise<VcsRouteResult> {
  if (typeof message !== "string" || message.trim() === "") return fail(400, "a commit message is required");
  const staged = (await git(repoRoot, ["diff", "--cached", "--name-only", "-z"])).stdout.split("\0").filter(Boolean);
  const bad = staged.filter(isAssets);
  if (bad.length > 0) return fail(400, `refusing to commit: ${ASSETS_MSG} (${bad.join(", ")} is staged; unstage it)`);
  if (staged.length === 0) return fail(400, "nothing is staged");
  const r = await git(repoRoot, ["commit", "-m", message]);
  return r.code === 0 ? ok({ output: r.stdout.trim() }) : fail(500, `git commit failed: ${(r.stderr || r.stdout).trim()}`);
}

// ponytail: remote is always "origin" and the branch is the current one; configurable remotes if needed.
async function sync(repoRoot: string, what: "pull" | "push", body: { confirm?: unknown }): Promise<VcsRouteResult> {
  if (body.confirm !== true) return fail(400, `${what} needs {"confirm": true}`);
  const branch = (await git(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) return fail(400, "not on a plain branch");
  const r = what === "pull"
    ? await git(repoRoot, ["pull", "--no-rebase", "--no-edit", "origin", branch])
    : await git(repoRoot, ["push", "--set-upstream", "origin", branch]);
  if (r.code === 0) return ok({ output: (r.stdout + r.stderr).trim() });
  const conflicts = what === "pull" ? await unmerged(repoRoot) : [];
  if (conflicts.length > 0) return fail(409, `pull stopped on ${conflicts.length} conflicted document${conflicts.length === 1 ? "" : "s"}; resolve them`, { conflicts });
  return fail(500, `git ${what} failed: ${(r.stderr || r.stdout).trim()}`);
}

// ---- merge resolution ---------------------------------------------------------------

const parse = (r: GitResult): Json | undefined => (r.code === 0 ? (JSON.parse(r.stdout) as Json) : undefined);

async function resolve(repoRoot: string, body: { path?: unknown; choices?: unknown }): Promise<VcsRouteResult> {
  const c = checkPath(repoRoot, body.path);
  if ("error" in c) return fail(400, c.error);
  if (!(await unmerged(repoRoot)).includes(c.path)) return fail(400, `${c.path} is not conflicted`);
  const choices = (typeof body.choices === "object" && body.choices !== null ? body.choices : {}) as Record<string, unknown>;
  let merged: Json | undefined;
  let conflicts;
  try {
    const [base, ours, theirs] = await Promise.all([1, 2, 3].map((n) => git(repoRoot, ["show", `:${n}:${c.path}`])));
    const m = mergeDocs(parse(base), parse(ours), parse(theirs), (p) => (choices[p] === "ours" || choices[p] === "theirs" ? (choices[p] as "ours" | "theirs") : undefined));
    merged = m.merged;
    conflicts = m.conflicts;
  } catch (e) {
    return fail(400, `${c.path} is not mergeable JSON: ${(e as Error).message}`);
  }
  if (conflicts.length > 0) return ok({ path: c.path, resolved: false, conflicts });
  if (merged === undefined) return fail(400, `${c.path} was deleted on both sides; resolve it with git`);
  const abs = join(repoRoot, c.path);
  const tmp = `${abs}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  renameSync(tmp, abs);
  const add = await git(repoRoot, ["add", "--", c.path]);
  return add.code === 0 ? ok({ path: c.path, resolved: true }) : fail(500, `git add failed: ${add.stderr.trim()}`);
}

// ---- soft locks -------------------------------------------------------------------------

const LOCKS = "content/locks.json";
type Locks = Record<string, { owner: string; since: string }>;

function readLocks(repoRoot: string): Locks {
  try {
    return (JSON.parse(readFileSync(join(repoRoot, LOCKS), "utf8")) as { locks?: Locks }).locks ?? {};
  } catch {
    return {};
  }
}

function writeLocks(repoRoot: string, locks: Locks): void {
  const abs = join(repoRoot, LOCKS);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, locks }, null, 2)}\n`, "utf8");
  renameSync(tmp, abs);
}

/** Advisory only: it tells other editors who is working on a document; nothing enforces it. */
function lock(repoRoot: string, take: boolean, body: { document?: unknown; owner?: unknown }): VcsRouteResult {
  const c = checkPath(repoRoot, body.document);
  if ("error" in c) return fail(400, c.error);
  if (!c.path.startsWith("content/") || c.path === LOCKS) return fail(400, "only documents under content/ can be locked");
  if (typeof body.owner !== "string" || !/^[\w .@-]{1,64}$/.test(body.owner)) return fail(400, "need an owner name (letters, digits, space . @ -)");
  const locks = readLocks(repoRoot);
  const held = locks[c.path];
  if (held && held.owner !== body.owner) return fail(409, `${c.path} is locked by ${held.owner} since ${held.since}`, { lock: held });
  if (take) locks[c.path] = held ?? { owner: body.owner, since: new Date().toISOString() };
  else delete locks[c.path];
  writeLocks(repoRoot, locks);
  return ok({ locks });
}

// ---- router ---------------------------------------------------------------------------------

/** Handle one request; null when the path is not a vcs route. `url` may carry a query string. */
export async function handleVcsRoute(repoRoot: string, method: string, url: string, rawBody: string | undefined): Promise<VcsRouteResult | null> {
  const u = new URL(url, "http://localhost");
  if (u.pathname !== "/api/editor/vcs" && !u.pathname.startsWith("/api/editor/vcs/")) return null;
  const action = u.pathname.split("/")[4] ?? "";
  let body: Record<string, unknown> = {};
  if (method === "POST") {
    try {
      body = JSON.parse(rawBody || "{}") as Record<string, unknown>;
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("not an object");
    } catch {
      return fail(400, "request body is not a JSON object");
    }
  }
  try {
    if (method === "GET") {
      if (action === "status") return await status(repoRoot);
      if (action === "diff") return await diff(repoRoot, u.searchParams.get("path"));
      if (action === "log") return await log(repoRoot);
      if (action === "locks") return ok({ locks: readLocks(repoRoot) });
    } else if (method === "POST") {
      if (action === "stage" || action === "unstage") {
        const c = checkPaths(repoRoot, body.paths);
        if ("error" in c) return fail(400, c.error);
        const r = await git(repoRoot, action === "stage" ? ["add", "--", ...c.paths] : ["restore", "--staged", "--", ...c.paths]);
        return r.code === 0 ? ok({ paths: c.paths }) : fail(500, `git ${action} failed: ${r.stderr.trim()}`);
      }
      if (action === "commit") return await commit(repoRoot, body.message);
      if (action === "pull" || action === "push") return await sync(repoRoot, action, body);
      if (action === "resolve") return await resolve(repoRoot, body);
      if (action === "lock" || action === "unlock") return lock(repoRoot, action === "lock", body);
    }
    return fail(404, "not found");
  } catch (err) {
    return fail(500, err instanceof Error ? err.message : String(err));
  }
}
