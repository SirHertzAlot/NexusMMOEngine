/**
 * "Make prefab" captures for slice EB3.
 *
 * The page is the real `ScenesPanel` (the same `scenes.tsx` frame EB4 uses)
 * and the little server under it answers with the editor host's own
 * handlers, including `/api/editor/gameplay`, which is where prefabs are
 * read and written.
 *
 * It runs against a throwaway project rather than this checkout, because
 * the point of the capture is the write: pressing the button writes
 * `content/prefabs/<name>.prefab.json`, and a picture of this repository
 * must not be able to change it. The project's `content` symlinks this
 * repository's own rules, items and crafting (the prefab validator reads
 * them) and has real folders only for `scenes` and `prefabs`.
 *
 * Run: node apps/editor/src/ui/forge/capture-prefab.mjs [outDir]
 * Default outDir: /mnt/project-files/marketing/editor-ui-2026
 *
 * Needs esbuild, playwright and a Chromium that can give WebGL
 * (SwiftShader is fine). Set CHROMIUM_PATH where Playwright's own browser
 * download is absent.
 */

import { build } from "esbuild";
import { chromium } from "playwright";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const { handleScenesRoute } = await import(dist("scenes-host.js"));
const { handleContentRoute } = await import(dist("scene-play.js"));
const { handleSceneVisualsRoute } = await import(dist("scene-visuals-host.js"));
const { handleGameplayRoute } = await import(dist("gameplay-routes.js"));

// ------------------------------------------------------- throwaway project

const project = mkdtempSync(join(tmpdir(), "mmo-prefab-"));
mkdirSync(join(project, "content", "scenes"), { recursive: true });
mkdirSync(join(project, "content", "prefabs"), { recursive: true });
for (const entry of readdirSync(join(repoRoot, "content"))) {
  if (entry === "scenes" || entry === "prefabs") continue;
  symlinkSync(join(repoRoot, "content", entry), join(project, "content", entry));
}
symlinkSync(join(repoRoot, "packages"), join(project, "packages"), "dir");

// One prefab that already exists, so the dialog can show a clash and the
// Details rail can show an instance that overrides one of its fields.
writeFileSync(
  join(project, "content", "prefabs", "goblin-camp.prefab.json"),
  `${JSON.stringify(
    {
      version: 1,
      name: "goblin-camp",
      components: { Spawner: { creature: "goblin", respawnSeconds: 90 } },
      children: [{ id: "lookout", transform: { position: [6, 0, 2] } }],
    },
    null,
    2,
  )}\n`,
);

// A scene with a camp to lift into a prefab, and one instance of the
// prefab above whose respawn this scene has changed.
writeFileSync(
  join(project, "content", "scenes", "vale.scene.json"),
  `${JSON.stringify(
    {
      version: 1,
      name: "vale",
      kind: "world",
      nodes: [
        { id: "camp-fire", name: "Camp fire", kind: "group", transform: { position: [10, 0, 4] } },
        { id: "tent-east", name: "Tent (east)", kind: "group", transform: { position: [14, 0, 4], rotation: [0, 90, 0] } },
        { id: "tent-west", name: "Tent (west)", kind: "group", transform: { position: [6, 0, 8] } },
        { id: "watch-tower", name: "Watch tower", kind: "group", transform: { position: [10, 0, 18] } },
        {
          id: "goblin-camp-1",
          name: "Goblin camp (south)",
          kind: "prefab",
          prefab: "goblin-camp",
          transform: { position: [-20, 0, -6] },
          components: { Spawner: { respawnSeconds: 20 } },
        },
      ],
    },
    null,
    2,
  )}\n`,
);

// ------------------------------------------------------------------ bundle

const tmpOut = resolve(repoRoot, "tmp_forge_eb3_preview");
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
  outdir: tmpOut,
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
    req.on("end", () => ok(text || ""));
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
    let text = "";
    if (method !== "GET") text = await readBody(req);
    const reply =
      (await handleGameplayRoute(project, method, url.pathname, req.headers["content-type"], async () => text)) ??
      handleScenesRoute(project, method, url.pathname, text || undefined) ??
      handleContentRoute(project, method, url.pathname) ??
      handleSceneVisualsRoute(project, method, url.pathname);
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
await tab.getByLabel("Open scene").selectOption("vale");
await tab.waitForTimeout(900);

// An instance of a prefab, and what this scene says differently about it.
await tab.getByRole("treeitem").filter({ hasText: "Goblin camp" }).first().click();
await tab.waitForTimeout(400);
await shot.screenshot({ path: resolve(outDir, "eb3-prefab-instance.png") });
console.log(`wrote ${resolve(outDir, "eb3-prefab-instance.png")}`);

// Pick the camp the way a person would, then make it a prefab.
const rows = tab.getByRole("treeitem");
await rows.nth(0).click();
for (const i of [1, 2]) await rows.nth(i).click({ modifiers: ["Control"] });
await tab.getByTestId("make-prefab").click();
await tab.waitForSelector('[data-testid="make-prefab-dialog"]');
await tab.getByTestId("make-prefab-name").fill("goblin-camp");
await tab.waitForTimeout(250);
await shot.screenshot({ path: resolve(outDir, "eb3-make-prefab-clash.png") });
console.log(`wrote ${resolve(outDir, "eb3-make-prefab-clash.png")}`);

await tab.getByTestId("make-prefab-name").fill("bandit-camp");
await tab.waitForTimeout(250);
await shot.screenshot({ path: resolve(outDir, "eb3-make-prefab.png") });
console.log(`wrote ${resolve(outDir, "eb3-make-prefab.png")}`);

await tab.getByTestId("make-prefab-create").click();
await tab.waitForSelector('[data-testid="prefab-instance"]');
await tab.waitForTimeout(500);
await shot.screenshot({ path: resolve(outDir, "eb3-prefab-made.png") });
console.log(`wrote ${resolve(outDir, "eb3-prefab-made.png")}`);

const written = join(project, "content", "prefabs", "bandit-camp.prefab.json");
if (!existsSync(written)) throw new Error("the button did not write the prefab file");
console.log(`wrote ${written}:\n${readFileSync(written, "utf8")}`);

await browser.close();
server.close();
rmSync(tmpOut, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });

if (errors.length > 0) {
  console.error(`page errors:\n${errors.join("\n")}`);
  process.exit(1);
}
