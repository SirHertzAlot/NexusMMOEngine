/**
 * Viewport captures for slice EB1: the same scene of real placeables drawn
 * with and without the visual table.
 *
 * The table is not a fixture. This script calls the host's own
 * `readSceneVisuals(repoRoot)` — the function behind
 * GET /api/editor/scene/visuals — so the sizes in the shot are the sizes
 * the engine would spawn in this checkout.
 *
 * Run: node apps/editor/src/ui/forge/capture-visuals.mjs [outDir]
 * Default outDir: /mnt/project-files/marketing/editor-ui-2026
 *
 * Needs esbuild, playwright and a Chromium that can give WebGL
 * (SwiftShader is fine). Set CHROMIUM_PATH where Playwright's own browser
 * download is absent.
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

// ------------------------------------------------- the real visual table

const hostJs = resolve(editorRoot, "dist/src/scene-visuals-host.js");
if (!existsSync(hostJs)) throw new Error("build the editor first: npm run build:lib --workspace=@mmo-engine/editor");
const { readSceneVisuals } = await import(pathToFileURL(hostJs).href);
const table = readSceneVisuals(repoRoot);
console.log(`visual table: ${Object.keys(table.visuals).length} ids, art pack ${table.art ? "present" : "absent"}`);

// ------------------------------------------------------------------ bundle

const bundled = await build({
  entryPoints: [resolve(here, "visuals.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  target: "chrome120",
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css", ".woff2": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  absWorkingDir: repoRoot,
  outdir: resolve(repoRoot, "tmp_forge_eb1_preview"),
  logLevel: "warning",
});
const js = bundled.outputFiles.find((f) => !f.path.endsWith(".css"))?.text ?? "";
if (!js) throw new Error("visuals bundle came out empty");

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

// ------------------------------------------------------------------- serve

const server = http.createServer((req, res) => {
  const fontMatch = /^\/fonts\/([a-z0-9.-]+\.woff2)$/.exec(req.url ?? "");
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
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${server.address().port}/`;

// ------------------------------------------------------------------- shoot

const browser = await chromium.launch({
  // SwiftShader gives this container a real WebGL context; without these
  // the canvas comes back blank and the shot proves nothing.
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const tab = await browser.newPage({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 2 });
const errors = [];
tab.on("pageerror", (e) => errors.push(e.message));
await tab.goto(url, { waitUntil: "networkidle" });
await tab.waitForSelector('[data-shot="visuals"]');
await tab.waitForFunction(() => window.__visualsReady === true);

const shot = tab.locator('[data-shot="visuals"]');
const drive = (step) => tab.evaluate((s) => window.__visualsDrive(s), step);

for (const [visuals, name] of [
  [{}, "eb1-markers-before.png"],
  [table.visuals, "eb1-sizes-after.png"],
]) {
  await drive({ visuals });
  await tab.waitForTimeout(400);
  await shot.screenshot({ path: resolve(outDir, name) });
  console.log(`wrote ${resolve(outDir, name)}`);
}

await browser.close();
server.close();
rmSync(resolve(repoRoot, "tmp_forge_eb1_preview"), { recursive: true, force: true });

if (errors.length > 0) {
  console.error(`page errors:\n${errors.join("\n")}`);
  process.exit(1);
}
