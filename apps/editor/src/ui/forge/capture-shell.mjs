/**
 * Shell-chrome captures for the 2026 editor design language (slice EU2).
 *
 * Bundles shell.tsx — the REAL `ForgeContextBar` over the real tool,
 * selection and play stores, with the real forge inspector beside it —
 * runs the editor's own Tailwind so the app.css side is the shipped
 * thing, then photographs the bar and films it reacting as those stores
 * change. Every GIF frame is the component responding to a store write,
 * so the motion is the component's, not a storyboard's.
 *
 * Run: node apps/editor/src/ui/forge/capture-shell.mjs [outDir]
 * Default outDir: /mnt/project-files/marketing/editor-ui-2026
 *
 * Needs esbuild, playwright and ffmpeg. Set CHROMIUM_PATH when
 * Playwright's own browser download is not on the machine.
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
const frameDir = resolve(repoRoot, "tmp_forge_frames");
mkdirSync(outDir, { recursive: true });
rmSync(frameDir, { recursive: true, force: true });
mkdirSync(frameDir, { recursive: true });

// ------------------------------------------------------------------ bundle

const bundled = await build({
  entryPoints: [resolve(here, "shell.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  target: "chrome120",
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "css", ".woff2": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  absWorkingDir: repoRoot,
  outdir: resolve(repoRoot, "tmp_forge_preview"),
  logLevel: "warning",
});
const js = bundled.outputFiles.find((f) => !f.path.endsWith(".css"))?.text ?? "";
if (!js) throw new Error("shell bundle came out empty");

const css = execFileSync(
  resolve(repoRoot, "node_modules/.bin/tailwindcss"),
  ["-c", resolve(editorRoot, "tailwind.config.js"), "-i", resolve(editorRoot, "src/app.css"), "--minify"],
  { cwd: editorRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
const forgeCss = readFileSync(resolve(editorRoot, "src/forge.css"), "utf8");
// The real committed graph, so the systems shot is of our actual systems.
const graph = readFileSync(resolve(repoRoot, "content/graph/ecs-graph.json"), "utf8");

const page = `<!doctype html><html><head><meta charset="utf-8">
<style>${css}</style><style>${forgeCss}</style>
<style>html,body{margin:0;background:#05080e;overflow:hidden}</style>
</head><body><div id="root"></div>
<script>window.__ECS_GRAPH = ${graph};</script>
<script>${js}</script></body></html>`;

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
  args: ["--no-sandbox"],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const tab = await browser.newPage({
  viewport: { width: 1180, height: 2100 },
  // 2 for the still a person looks at; the GIF frames are shot at 1 so the
  // file stays small enough to post.
  deviceScaleFactor: 2,
});
await tab.goto(url, { waitUntil: "networkidle" });
await tab.waitForSelector('[data-shot="chrome"]');

const drive = (step) => tab.evaluate((s) => window.__forgeDrive(s), step);

// The still: a dirty branch, a selection, a running server, two problems —
// the state a developer is actually in most of the time.
await drive({ tree: "changed", tool: "move", play: "running", problems: 2, select: true });
await tab.waitForTimeout(300);
await tab.locator('[data-shot="chrome"]').screenshot({
  path: resolve(outDir, "eu2-context-bar.png"),
});
console.log(`wrote ${resolve(outDir, "eu2-context-bar.png")}`);
// The bar on its own, cropped, so the chips are legible in a PR.
await tab.locator(".fg-contextbar").screenshot({
  path: resolve(outDir, "eu2-context-bar-strip.png"),
});
console.log(`wrote ${resolve(outDir, "eu2-context-bar-strip.png")}`);

await tab.locator('[data-shot="profiler"]').screenshot({
  path: resolve(outDir, "eu7-profiler.png"),
});
console.log(`wrote ${resolve(outDir, "eu7-profiler.png")}`);

await tab.locator('[data-shot="systems"]').screenshot({
  path: resolve(outDir, "eu4-systems.png"),
});
console.log(`wrote ${resolve(outDir, "eu4-systems.png")}`);

await tab.locator('[data-shot="integrations"]').screenshot({
  path: resolve(outDir, "eu5-integrations.png"),
});
console.log(`wrote ${resolve(outDir, "eu5-integrations.png")}`);

// ------------------------------------------------------------------- film

/**
 * One pass through the states the bar distinguishes. Each step is a write
 * to the store the running editor writes, so the frame after it is the
 * component's own reaction.
 */
const script = [
  { tree: "clean", tool: "select", play: "idle", problems: 0, select: false },
  { select: true },
  { tool: "move" },
  { play: "starting" },
  { play: "running" },
  { tree: "changed" },
  { problems: 2 },
  { tree: "conflict" },
  { play: "error" },
  { tree: "clean", tool: "select", play: "idle", problems: 0, select: false },
];

const strip = tab.locator(".fg-contextbar");
let frame = 0;
const hold = 4; // frames per state, at 6 fps -> about 0.65s each
for (const step of script) {
  await drive(step);
  await tab.waitForTimeout(160);
  for (let i = 0; i < hold; i += 1) {
    await strip.screenshot({ path: resolve(frameDir, `f${String(frame).padStart(4, "0")}.png`) });
    frame += 1;
  }
}
console.log(`shot ${frame} frames`);

await browser.close();
server.close();

// ------------------------------------------------------------------- gif

const gif = resolve(outDir, "eu2-context-bar.gif");
execFileSync(
  "ffmpeg",
  [
    "-y", "-framerate", "6", "-i", resolve(frameDir, "f%04d.png"),
    "-filter_complex", "[0:v]split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=bayer",
    "-loop", "0", gif,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
console.log(`wrote ${gif}`);
rmSync(frameDir, { recursive: true, force: true });
