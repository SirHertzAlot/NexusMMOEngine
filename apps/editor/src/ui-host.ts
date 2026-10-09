/**
 * Player-interface content for the editor dev host (roadmap EA23, EA25):
 * the HUD layout `content/ui/hud.json` and the string tables
 * `content/strings/<lang>.json`, both read by the real client. Loopback
 * routes (wired in host.ts):
 *
 *   GET /api/editor/hud               → { content, catalog }
 *   PUT /api/editor/hud               → { content } → validate, then write
 *   GET /api/editor/strings           → every language, its status against English,
 *                                       and what the client's t() calls use
 *   PUT /api/editor/strings/<lang>    → { content } → validate, then write (new languages too)
 *
 * Saves are validated by @mmo-engine/scene (`validateHud`, `validateStrings`);
 * a refused save answers 400 with every issue and writes nothing. The
 * language in the path must match the language code pattern before any path
 * is built, and "pseudo" is reserved (it is made from English, never stored).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HUD_CATALOG, PSEUDO_LANG, SOURCE_LANG, stringsStatus, validateHud, validateStrings, type StringsBundle, type StringsStatus } from "@mmo-engine/scene";

type Reply = { status: number; body: unknown };
const LANG_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

const hudFile = (repoRoot: string): string => join(resolve(repoRoot, "content", "ui"), "hud.json");
const stringsDir = (repoRoot: string): string => resolve(repoRoot, "content", "strings");

function writeJson(file: string, dir: string, content: unknown): void {
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

function refuse(issues: unknown[]): never {
  throw Object.assign(new Error(`invalid: ${issues.length} problem${issues.length === 1 ? "" : "s"}`), { status: 400, issues });
}

// ------------------------------------------------------------------ extraction

export interface ClientStrings {
  /** Every id a `t("id")` call names, with the client source files (relative to src) that call it. */
  ids: Record<string, string[]>;
  /** Prefixes of computed ids, t(`prefix.${x}`). */
  prefixes: string[];
  /** All the client source, to find ids used as plain literals in tables (labels, badges). */
  text: string;
}

function walk(dir: string, rel = ""): Array<{ rel: string; file: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
      : /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")
        ? [{ rel: rel ? `${rel}/${e.name}` : e.name, file: join(dir, e.name) }]
        : [],
  );
}

/** What the client's source asks `t()` for. */
export function scanClientStrings(repoRoot: string): ClientStrings {
  const ids: Record<string, string[]> = {};
  const prefixes = new Set<string>();
  let text = "";
  for (const { rel, file } of walk(resolve(repoRoot, "apps", "client", "src"))) {
    const src = readFileSync(file, "utf8");
    text += `${src}\n`;
    for (const m of src.matchAll(/\bt\(\s*"([A-Za-z][A-Za-z0-9.-]*)"/g)) {
      const files = (ids[m[1]] ??= []);
      if (!files.includes(rel)) files.push(rel);
    }
    for (const m of src.matchAll(/\bt\(\s*`([A-Za-z][A-Za-z0-9.-]*\.)\$\{/g)) prefixes.add(m[1]);
  }
  return { ids, prefixes: [...prefixes].sort(), text };
}

function readLangs(repoRoot: string): Record<string, StringsBundle> {
  const dir = stringsDir(repoRoot);
  const out: Record<string, StringsBundle> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const lang = f.slice(0, -5);
    if (LANG_RE.test(lang)) out[lang] = JSON.parse(readFileSync(join(dir, f), "utf8")) as StringsBundle;
  }
  return out;
}

// ------------------------------------------------------------------ routes

export function handleUiRoute(repoRoot: string, method: string, pathname: string, body: string | undefined): Reply | null {
  const isHud = pathname === "/api/editor/hud";
  const isStrings = pathname === "/api/editor/strings" || pathname.startsWith("/api/editor/strings/");
  if (!isHud && !isStrings) return null;
  const notFound: Reply = { status: 404, body: { ok: false, error: "not found" } };
  try {
    if (isHud) {
      if (method === "GET") {
        const file = hudFile(repoRoot);
        if (!existsSync(file)) return { status: 404, body: { ok: false, error: "no hud.json" } };
        return { status: 200, body: { ok: true, content: JSON.parse(readFileSync(file, "utf8")) as unknown, catalog: HUD_CATALOG } };
      }
      if (method === "PUT") {
        const content = parseContent(body);
        if (content instanceof Error) return { status: 400, body: { ok: false, error: content.message } };
        const issues = validateHud(content.content);
        if (issues.length > 0) refuse(issues);
        writeJson(hudFile(repoRoot), resolve(repoRoot, "content", "ui"), content.content);
        return { status: 200, body: { ok: true } };
      }
      return notFound;
    }
    if (pathname === "/api/editor/strings" && method === "GET") {
      const langs = readLangs(repoRoot);
      const source = langs[SOURCE_LANG];
      if (!source) return { status: 404, body: { ok: false, error: "no en.json" } };
      const scan = scanClientStrings(repoRoot);
      const status: Record<string, StringsStatus> = {};
      for (const [l, b] of Object.entries(langs)) status[l] = stringsStatus(source, b);
      const have = new Set(Object.keys(source.messages));
      const missingInSource = Object.keys(scan.ids).filter((id) => !have.has(id));
      const unused = [...have].filter((id) => !(id in scan.ids) && !scan.text.includes(`"${id}"`) && !scan.prefixes.some((p) => id.startsWith(p)));
      return { status: 200, body: { ok: true, langs, status, used: scan.ids, prefixes: scan.prefixes, missingInSource, unused } };
    }
    const m = /^\/api\/editor\/strings\/([^/]+)$/.exec(pathname);
    if (m && method === "PUT") {
      let lang: string;
      try {
        lang = decodeURIComponent(m[1]);
      } catch {
        return { status: 400, body: { ok: false, error: "bad language" } };
      }
      if (lang === PSEUDO_LANG) return { status: 400, body: { ok: false, error: "pseudo is made from English; it has no file" } };
      if (!LANG_RE.test(lang)) return { status: 400, body: { ok: false, error: `"${lang}" is not a language code like en or pt-BR` } };
      const content = parseContent(body);
      if (content instanceof Error) return { status: 400, body: { ok: false, error: content.message } };
      const issues = validateStrings(content.content, lang);
      if (issues.length > 0) refuse(issues);
      writeJson(join(stringsDir(repoRoot), `${lang}.json`), stringsDir(repoRoot), content.content);
      return { status: 200, body: { ok: true } };
    }
    return notFound;
  } catch (err) {
    const e = err as { status?: number; issues?: unknown };
    return {
      status: e.status ?? 500,
      body: { ok: false, error: err instanceof Error ? err.message : String(err), ...(Array.isArray(e.issues) ? { issues: e.issues } : {}) },
    };
  }
}

function parseContent(body: string | undefined): { content: unknown } | Error {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? "") as unknown;
  } catch {
    return new Error("request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || !("content" in parsed)) return new Error('need a JSON body shaped like {"content": …}');
  return { content: (parsed as { content: unknown }).content };
}
