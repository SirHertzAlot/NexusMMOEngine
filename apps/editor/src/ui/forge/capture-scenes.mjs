/**
 * Scenes workspace captures for slices EB4 and EB4b.
 *
 * The page is the real `ScenesPanel`, and the little server under it
 * answers with the editor host's own handlers — `handleScenesRoute`,
 * `handleContentRoute`, `handleSceneVisualsRoute` — so the scene it opens,
 * the content in the palette and the sizes in the viewport all come from
 * this checkout rather than from a fixture.
 *
 * Run: node apps/editor/src/ui/forge/capture-scenes.mjs [outDir]
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
const SCENE = process.env.SCENE ?? "test-arena";
mkdirSync(outDir, { recursive: true });

const dist = (file) => {
  const path = resolve(editorRoot, "dist/src", file);
  if (!existsSync(path)) throw new Error("build the editor first: npm run build:lib --workspace=@mmo-engine/editor");
  return pathToFileURL(path).href;
};
const { handleScenesRoute } = await import(dist("scenes-host.js"));
const { handleContentRoute } = await import(dist("scene-play.js"));
const { handleSceneVisualsRoute } = await import(dist("scene-visuals-host.js"));

// ------------------------------------------------------------------ bundle

const bundled = await build({
  entryPoints: [resolve(here, "scenes.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  target: "chrome120",
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css", ".woff2": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  absWorkingDir: repoRoot,
  outdir: resolve(repoRoot, "tmp_forge_eb4_preview"),
  logLevel: "warning",
});
const js = bundled.outputFiles.find((f) => !f.path.endsWith(".css"))?.text ?? "";
if (!js) throw new Error("scenes bundle came out empty");

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
    const reply =
      handleScenesRoute(repoRoot, method, url.pathname, body) ??
      handleContentRoute(repoRoot, method, url.pathname) ??
      handleSceneVisualsRoute(repoRoot, method, url.pathname);
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
const tab = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
const errors = [];
tab.on("pageerror", (e) => errors.push(e.message));
await tab.goto(url, { waitUntil: "networkidle" });
await tab.waitForSelector('[data-shot="scenes"]');
await tab.waitForFunction(() => window.__scenesReady === true);

const shot = tab.locator('[data-shot="scenes"]');
await tab.getByLabel("Open scene").selectOption(SCENE);
await tab.waitForTimeout(900);
await shot.screenshot({ path: resolve(outDir, "eb4-scenes-workspace.png") });
console.log(`wrote ${resolve(outDir, "eb4-scenes-workspace.png")}`);

// The palette's search, which is what replaced the chip rows.
await tab.getByTestId("palette-search").fill("wolf");
await tab.waitForTimeout(250);
await shot.screenshot({ path: resolve(outDir, "eb4-palette-search.png") });
console.log(`wrote ${resolve(outDir, "eb4-palette-search.png")}`);

// EB2: a set, picked the way a person picks one — a click, then
// ctrl-clicks — with the align controls that appear once there is a set.
await tab.getByTestId("palette-search").fill("");
const rows = tab.getByRole("treeitem");
await rows.nth(1).click();
for (const i of [2, 3, 4]) await rows.nth(i).click({ modifiers: ["Control"] });
await tab.waitForTimeout(400);
await shot.screenshot({ path: resolve(outDir, "eb2-multi-select.png") });
console.log(`wrote ${resolve(outDir, "eb2-multi-select.png")}`);

await browser.close();
server.close();
rmSync(resolve(repoRoot, "tmp_forge_eb4_preview"), { recursive: true, force: true });

if (errors.length > 0) {
  console.error(`page errors:\n${errors.join("\n")}`);
  process.exit(1);
}
