/**
 * Flow preview capture for slice EB6: the real pane framing the real client.
 *
 * It needs the client's dev server running (npm run dev --workspace
 * @mmo-engine/client, or CLIENT_URL pointing elsewhere); without one the
 * frame would be empty, so the script says so and stops rather than
 * writing a picture of nothing.
 *
 * Run: node apps/editor/src/ui/forge/capture-flow-preview.mjs [outDir]
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

const CLIENT = process.env.CLIENT_URL ?? "http://localhost:5173";
const reachable = await fetch(CLIENT).then((r) => r.ok).catch(() => false);
if (!reachable) {
  console.error(`no client dev server at ${CLIENT} — start one, or set CLIENT_URL`);
  process.exit(1);
}

// ------------------------------------------------------------------ bundle

const bundled = await build({
  entryPoints: [resolve(here, "flow-preview.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  target: "chrome120",
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css", ".woff2": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  absWorkingDir: repoRoot,
  outdir: resolve(repoRoot, "tmp_forge_eb6_preview"),
  logLevel: "warning",
});
const js = bundled.outputFiles.find((f) => !f.path.endsWith(".css"))?.text ?? "";
if (!js) throw new Error("flow preview bundle came out empty");

const css = execFileSync(
  resolve(repoRoot, "node_modules/.bin/tailwindcss"),
  ["-c", resolve(editorRoot, "tailwind.config.js"), "-i", resolve(editorRoot, "src/app.css"), "--minify"],
  { cwd: editorRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
const forgeCss = readFileSync(resolve(editorRoot, "src/forge.css"), "utf8");

const page = `<!doctype html><html><head><meta charset="utf-8">
<style>${css}</style><style>${forgeCss}</style>
<style>html,body{margin:0;background:#05080e;overflow:hidden}</style>
<script>window.__client = ${JSON.stringify(CLIENT)};</script>
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
const tab = await browser.newPage({ viewport: { width: 900, height: 470 }, deviceScaleFactor: 2 });
const errors = [];
tab.on("pageerror", (e) => errors.push(e.message));
await tab.goto(url, { waitUntil: "networkidle" });
await tab.waitForSelector('[data-shot="flow-preview"]');
await tab.waitForFunction(() => window.__previewReady === true);
// The client inside the frame has to boot before the shot means anything.
await tab.waitForTimeout(4000);

const shot = tab.locator('[data-shot="flow-preview"]');
await shot.screenshot({ path: resolve(outDir, "eb6-flow-preview.png") });
console.log(`wrote ${resolve(outDir, "eb6-flow-preview.png")}`);

await browser.close();
server.close();
rmSync(resolve(repoRoot, "tmp_forge_eb6_preview"), { recursive: true, force: true });

if (errors.length > 0) {
  console.error(`page errors:\n${errors.join("\n")}`);
  process.exit(1);
}
