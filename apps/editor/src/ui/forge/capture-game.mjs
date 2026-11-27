/**
 * Game panel captures for slice EB10.
 *
 * Two shots of the real `GamePanel`: a project with no `game.json`,
 * which is what the engine checkout itself is, and the same project
 * after the manifest has been written, with each module's declared
 * settings. The server under the page is the editor host's own
 * `handleGameRoute` over a throwaway project folder that links this
 * repository's modules, so the modules and their settings are real; the
 * manifest is written in that folder and nowhere near the checkout.
 *
 * Run: node apps/editor/src/ui/forge/capture-game.mjs [outDir]
 */

import { build } from "esbuild";
import { chromium } from "playwright";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
const { handleGameRoute } = await import(dist("game-host.js"));

// A throwaway project: this repository's modules, its own content and
// its own (absent, then written) game.json.
const project = mkdtempSync(resolve(tmpdir(), "mmo-forge-game-"));
mkdirSync(resolve(project, "content"), { recursive: true });
symlinkSync(resolve(repoRoot, "modules"), resolve(project, "modules"), "dir");
symlinkSync(resolve(repoRoot, "packages"), resolve(project, "packages"), "dir");
writeFileSync(
  resolve(project, "content/modules.json"),
  JSON.stringify({ modules: ["core", "sample-heartbeat"] }, null, 2),
  "utf8",
);

// ------------------------------------------------------------------ bundle

const bundled = await build({
  entryPoints: [resolve(here, "game.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  target: "chrome120",
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css", ".woff2": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  absWorkingDir: repoRoot,
  outdir: resolve(repoRoot, "tmp_forge_eb10_preview"),
  logLevel: "warning",
});
const js = bundled.outputFiles.find((f) => !f.path.endsWith(".css"))?.text ?? "";
if (!js) throw new Error("game bundle came out empty");

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
    // Writes land in the throwaway project, never in the checkout.
    const reply = await handleGameRoute(project, method, url.pathname, body);
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
const tab = await browser.newPage({ viewport: { width: 1180, height: 640 }, deviceScaleFactor: 2 });
const errors = [];
tab.on("pageerror", (e) => errors.push(e.message));
await tab.goto(url, { waitUntil: "networkidle" });
await tab.waitForSelector('[data-shot="game"]');
await tab.waitForFunction(() => window.__gameReady === true);
await tab.waitForTimeout(500);

const shot = tab.locator('[data-shot="game"]');
await shot.screenshot({ path: resolve(outDir, "eb10-game-none.png") });
console.log(`wrote ${resolve(outDir, "eb10-game-none.png")}`);

// Writing the manifest is a button, so press it the way a person would.
await tab.getByLabel("Name").fill("Nexus Demo");
await tab.getByLabel("Description").fill("A game made from the engine's own content");
await tab.getByTestId("game-create").click();
await tab.waitForSelector('[data-testid="game-module-sample-heartbeat"]');
await tab.waitForTimeout(400);
await shot.screenshot({ path: resolve(outDir, "eb10-game-settings.png") });
console.log(`wrote ${resolve(outDir, "eb10-game-settings.png")}`);

await browser.close();
server.close();
rmSync(resolve(repoRoot, "tmp_forge_eb10_preview"), { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });

if (errors.length > 0) {
  console.error(`page errors:\n${errors.join("\n")}`);
  process.exit(1);
}
