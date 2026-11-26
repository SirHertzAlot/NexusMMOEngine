/**
 * Opening a source location in the developer's own editor
 * (docs/EDITOR-UI-2026.md §2.6, slice EU9).
 *
 * The functionality mockup has a Code tab with an editor and a terminal
 * inside the engine. We are not building that, and the reason is a
 * boundary we already enforce twice: `files-host.ts` serves whitelisted
 * document kinds only, and `vcs-host.ts` refuses every path under
 * `assets/` because that art is licensed and confidential. An editor
 * over arbitrary source, served by the same loopback host, would undo
 * both — and it would be a worse editor than the one the person already
 * has open on the other monitor.
 *
 * So the editor hands off instead. The parts worth having are the ones
 * an embedded editor would have given us anyway: the editor knows WHERE
 * things are — every system node in the committed ECS graph carries
 * `file:line` — and a click should land you there.
 *
 * This module is the path arithmetic and the refusals, kept pure and
 * browser-safe so both the button and the host route apply exactly the
 * same rules. The host spawns `code -g`; the browser can also fall back
 * to the `vscode://` URI handler, which needs no host at all.
 */

export interface SourceRef {
  /** Repository-relative, POSIX separators. */
  relPath: string;
  /** 1-based, or null when the reference names a file only. */
  line: number | null;
}

/**
 * Parse the `file:line` form the ECS graph records on every node and
 * edge (`packages/engine-core/src/abilities.ts:51`). A trailing column
 * is accepted and dropped — we re-add our own. Returns null for
 * anything that is not a usable reference, so a caller never has to
 * guess whether an empty string meant "the repository root".
 */
export function parseSourceRef(raw: string): SourceRef | null {
  const text = raw.trim();
  if (text === "") return null;
  const parts = text.split(":");
  // Peel at most two trailing numeric segments (line, then column).
  let line: number | null = null;
  for (let i = 0; i < 2 && parts.length > 1; i += 1) {
    const last = parts[parts.length - 1];
    if (!/^\d+$/.test(last)) break;
    parts.pop();
    line = Number(last); // the inner one wins: "f.ts:51:4" is line 51
  }
  const relPath = parts.join(":").trim();
  if (relPath === "") return null;
  if (line !== null && line < 1) line = null;
  return { relPath, line };
}

const ASSETS_MSG =
  "paths under assets/ are confidential licensed art; the dev server serves them locally and nothing else opens them";

/**
 * Why this path cannot be opened, or null when it can. Same shape of
 * answer as `vcs-host.ts`'s path guard, and the same `assets/` rule:
 * one boundary, stated once per tool that could cross it.
 */
export function refuseOpen(relPath: string): string | null {
  const p = relPath.trim();
  if (p === "") return "no path";
  if (/[\0-\x1f]/.test(p)) return `"${relPath}": control characters in a path`;
  if (p.includes("\\")) return `"${relPath}": use / in a repository path`;
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return `"${relPath}": only repository-relative paths are opened`;
  const segments = p.split("/");
  if (segments.some((s) => s === "..")) return `"${relPath}": a path may not leave the repository`;
  if (segments.some((s) => s === "")) return `"${relPath}": empty path segment`;
  // Trailing dots and spaces are stripped by Windows, so `assets.` would
  // otherwise reach `assets/` there — the same normalisation vcs-host.ts does.
  if (segments[0].replace(/[. ]+$/, "").toLowerCase() === "assets") return `"${relPath}": ${ASSETS_MSG}`;
  return null;
}

/** The repository-relative path with POSIX separators, for joining. */
const posix = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * The `vscode://` URI for a reference — the handoff that needs no host
 * process, only VS Code installed and registered for the scheme. The
 * browser is on the same machine as the host (loopback), so the
 * absolute path is the right one.
 */
export function vscodeUri(repoRoot: string, ref: SourceRef): string {
  const root = posix(repoRoot);
  const abs = `${root.startsWith("/") ? root : `/${root}`}/${ref.relPath}`;
  return `vscode://file${encodeURI(abs)}${ref.line === null ? "" : `:${ref.line}:1`}`;
}

/**
 * The command to copy when the URI handler is not registered and the
 * host cannot spawn. Deliberately relative: it is pasted at the
 * repository root, and it does not print the person's home directory
 * into a panel that may end up in a screenshot.
 */
export function codeCommand(ref: SourceRef): string {
  const target = ref.line === null ? ref.relPath : `${ref.relPath}:${ref.line}`;
  return `code -g ${/[\s"']/.test(target) ? JSON.stringify(target) : target}`;
}

/** `abilities.ts:51` — what a button says, without the path that led there. */
export function refLabel(ref: SourceRef): string {
  const base = ref.relPath.split("/").pop() ?? ref.relPath;
  return ref.line === null ? base : `${base}:${ref.line}`;
}
