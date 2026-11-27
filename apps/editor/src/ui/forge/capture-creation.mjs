/**
 * Character creation capture for slice EB7.
 *
 * The page is the real `CreationRulesPanel` and the server under it
 * answers `/api/editor/docs/characterCreation` with the editor host's own
 * handler, so the form holds this repository's
 * content/character-creation.json and a save would be validated by the
 * art package's reader, exactly as in the editor.
 *
 * Run: node apps/editor/src/ui/forge/capture-creation.mjs [outDir]
 *
 * Needs esbuild and playwright; set CHROMIUM_PATH where Playwright's own
 * browser download is absent.
 */

import { build } from "esbuild";
import { chromium } from "playwright";
import http from "node:http";
import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const editorRoot = resolve(here, "..", "..", "..");
const repoRoot = resolve(editorRoot, "..", "..");
const outDir = process.argv[2] ?? "/mnt/project-files/marketing/editor-ui-2026";
mkdirSync(outDir, { recursive: true });

const dist = (file) => {
  const path = resolve(editorRoot, "dist/src", file);
  if (!existsSync(path)) throw new Error("build the editor first: npm run build:lib --workspace=@mmo-engine/editor");
  return pathToFileURL(path).href;
};
const { handleContentDocsRoute } = await import(dist("content-docs-host.js"));

// ------------------------------------------------------------------ bundle

const bundled = await build({
  entryPoints: [resolve(here, "creation.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  target: "chrome120",
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css", ".woff2": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  absWorkingDir: repoRoot,
  outdir: resolve(repoRoot, "tmp_forge_eb7_preview"),
  logLevel: "warning",
});
const js = bundled.outputFiles.find((f) => !f.path.endsWith(".css"))?.text ?? "";
if (!js) throw new Error("creation bundle came out empty");

const css = execFileSync(
  resolve(repoRoot, "node_modules/.bin/tailwindcss"),
  ["-c", resolve(editorRoot, "tailwind.config.js"), "-i", resolve(editorRoot, "src/app.css"), "--minify"],
  { cwd: editorRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
const forgeCss = readFileSync(resolve(editorRoot, "src/forge.css"), "utf8");

const page = `<!doctype html><html><head><meta charset="utf-8">
<style>${css}</style><style>${forgeCss}</style>
<style>html,body{margin:0;background:#05080e;overflow:hidden}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;

// ------------------------------------------------- serve, with real routes

const readBody = (req) =>
  new Promise((ok) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => ok(text || undefined));
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const json = (reply) => {
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  };
  const fontMatch = /^\/fonts\/([a-z0-9.-]+\.woff2)$/.exec(url.pathname);
  if (fontMatch) {
    const file = resolve(editorRoot, "src/fonts", fontMatch[1]);
    if (existsSync(file)) {
      res.writeHead(200, { "content-type": "font/woff2" });
      res.end(readFileSync(file));
      return;
    }
    res.writeHead(404).end();
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    const method = req.method ?? "GET";
    const body = method === "GET" ? undefined : await readBody(req);
    // Read-only: a picture of this repository must not be able to change it.
    if (method !== "GET") {
      json({ status: 405, body: { ok: false, error: "the capture host only reads" } });
      return;
    }
    const reply = await handleContentDocsRoute(repoRoot, method, url.pathname, body);
    json(reply ?? { status: 404, body: { ok: false, error: "not served by the capture host" } });
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${server.address().port}/`;

// ------------------------------------------------------------------- shoot

const browser = await chromium.launch({
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const tab = await browser.newPage({ viewport: { width: 1180, height: 2060 }, deviceScaleFactor: 2 });
const errors = [];
tab.on("pageerror", (e) => errors.push(e.message));
await tab.goto(url, { waitUntil: "networkidle" });
await tab.waitForSelector('[data-shot="creation"]');
await tab.waitForFunction(() => window.__creationReady === true);
await tab.waitForTimeout(800);

const shot = tab.locator('[data-shot="creation"]');
await shot.screenshot({ path: resolve(outDir, "eb7-character-creation.png") });
console.log(`wrote ${resolve(outDir, "eb7-character-creation.png")}`);

await browser.close();
server.close();
rmSync(resolve(repoRoot, "tmp_forge_eb7_preview"), { recursive: true, force: true });

if (errors.length > 0) {
  console.error(`page errors:\n${errors.join("\n")}`);
  process.exit(1);
}
