/**
 * Viewport captures for slice EU6: the real `SceneView` over a tiny
 * scene, with the gizmo following the real shared tool store and the
 * corner axis triad on.
 *
 * Every GIF frame is the component reacting to a write to `tool-store.ts`
 * — the same store the toolbar writes — not a storyboard of mock states.
 *
 * Run: node apps/editor/src/ui/forge/capture-viewport.mjs [outDir]
 * Default outDir: /mnt/project-files/marketing/editor-ui-2026
 *
 * Needs esbuild, playwright and ffmpeg, and a Chromium that can give
 * WebGL (SwiftShader is fine). Set CHROMIUM_PATH where Playwright's own
 * browser download is absent.
 */

import { build } from "esbuild";
import { chromium } from "playwright";
import http from "node:http";
import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const editorRoot = resolve(here, "..", "..", "..");
const repoRoot = resolve(editorRoot, "..", "..");
const outDir = process.argv[2] ?? "/mnt/project-files/marketing/editor-ui-2026";
const frameDir = resolve(repoRoot, "tmp_forge_vp_frames");
mkdirSync(outDir, { recursive: true });
rmSync(frameDir, { recursive: true, force: true });
mkdirSync(frameDir, { recursive: true });

// ------------------------------------------------------------------ bundle

const bundled = await build({
  entryPoints: [resolve(here, "viewport.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  target: "chrome120",
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css", ".woff2": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  absWorkingDir: repoRoot,
  outdir: resolve(repoRoot, "tmp_forge_vp_preview"),
  logLevel: "warning",
});
const js = bundled.outputFiles.find((f) => !f.path.endsWith(".css"))?.text ?? "";
if (!js) throw new Error("viewport bundle came out empty");

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
const tab = await browser.newPage({
  viewport: { width: 900, height: 560 },
  deviceScaleFactor: 2,
});
await tab.goto(url, { waitUntil: "networkidle" });
await tab.waitForSelector('[data-shot="viewport"]');
await tab.waitForFunction(() => window.__viewportReady === true);

const drive = (step) => tab.evaluate((s) => window.__viewportDrive(s), step);
const shot = tab.locator('[data-shot="viewport"]');

for (const [tool, name] of [
  ["move", "eu6-gizmo-translate.png"],
  ["rotate", "eu6-gizmo-rotate.png"],
  ["scale", "eu6-gizmo-scale.png"],
  ["select", "eu6-gizmo-none.png"],
]) {
  await drive({ tool });
  await tab.waitForTimeout(350);
  await shot.screenshot({ path: resolve(outDir, name) });
  console.log(`wrote ${resolve(outDir, name)}`);
}

// ------------------------------------------------------------------- film

// One pass through the tools. Each step is a write to the shared store;
// the gizmo in the next frame is SceneView's own reaction to it.
const script = [
  { tool: "select" },
  { tool: "move" },
  { tool: "rotate" },
  { tool: "scale" },
  { tool: "select" },
];

let frame = 0;
const hold = 5; // frames per tool, at 6 fps -> about 0.8s each
for (const step of script) {
  await drive(step);
  await tab.waitForTimeout(200);
  for (let i = 0; i < hold; i += 1) {
    await shot.screenshot({ path: resolve(frameDir, `f${String(frame).padStart(4, "0")}.png`) });
    frame += 1;
  }
}
console.log(`shot ${frame} frames`);

await browser.close();
server.close();

// ------------------------------------------------------------------- gif

const gif = resolve(outDir, "eu6-gizmo-tools.gif");
execFileSync(
  "ffmpeg",
  [
    "-y", "-framerate", "6", "-i", resolve(frameDir, "f%04d.png"),
    "-filter_complex", "[0:v]scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer",
    "-loop", "0", gif,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
console.log(`wrote ${gif}`);
rmSync(frameDir, { recursive: true, force: true });
