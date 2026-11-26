/**
 * Before/after captures for the 2026 editor design language.
 *
 * Bundles preview.tsx (the real Material 3 ECS panel and the real Forge
 * inspector over one fixture snapshot), runs the EDITOR'S OWN Tailwind
 * over the editor's own app.css so the "before" shot is the real thing
 * and not an approximation, serves the page, and photographs each half
 * plus the pair together.
 *
 * Run: node apps/editor/src/ui/forge/capture.mjs [outDir]
 * Default outDir: /mnt/project-files/marketing/editor-ui-2026-11-22
 *
 * Needs the workspace installed (esbuild and playwright come with it);
 * set CHROMIUM_PATH if Playwright's own browser download is not there.
 * Nothing here touches the components: it renders and photographs them.
 */

import { build } from "esbuild";
import { chromium } from "playwright";
import http from "node:http";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const editorRoot = resolve(here, "..", "..", "..");
const repoRoot = resolve(editorRoot, "..", "..");
const outDir = process.argv[2] ?? "/mnt/project-files/marketing/editor-ui-2026-11-22";
mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------------ bundle

const bundled = await build({
  entryPoints: [resolve(here, "preview.tsx")],
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
if (!js) throw new Error("preview bundle came out empty");

// The Material 3 panel is Tailwind-classed, so the "before" half has to be
// the editor's REAL Tailwind output with the editor's own config.
const css = execFileSync(
  resolve(repoRoot, "node_modules/.bin/tailwindcss"),
  ["-c", resolve(editorRoot, "tailwind.config.js"), "-i", resolve(editorRoot, "src/app.css"), "--minify"],
  { cwd: editorRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
const forgeCss = readFileSync(resolve(editorRoot, "src/forge.css"), "utf8");

const page = `<!doctype html><html><head><meta charset="utf-8">
<style>${css}</style><style>${forgeCss}</style>
<style>html,body{margin:0;background:#07090f;overflow:auto}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;

// ------------------------------------------------------------------- serve

const server = http.createServer((req, res) => {
  // The @font-face rules in app.css point at ./fonts/*, so serve them:
  // the forge labels read by width and tracking, which needs Roboto Flex.
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

// CHROMIUM_PATH lets a machine whose Chromium came from somewhere other
// than `npx playwright install` (CI images, cloud containers) point at it.
const browser = await chromium.launch({
  args: ["--no-sandbox"],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const tab = await browser.newPage({
  viewport: { width: 1220, height: 860 },
  deviceScaleFactor: 2,
});
await tab.goto(url, { waitUntil: "networkidle" });
await tab.waitForSelector('[data-shot="after"]');
// Open a component row so the "after" shot shows the expanded state too.
await tab.locator('[data-shot="after"] button[aria-expanded]').first().click();
await tab.waitForTimeout(250);

const shots = [
  ['[data-shot="before"]', "proof-inspector-before.png"],
  ['[data-shot="after"]', "proof-inspector-after.png"],
];
for (const [selector, name] of shots) {
  await tab.locator(selector).screenshot({ path: resolve(outDir, name) });
  console.log(`wrote ${resolve(outDir, name)}`);
}
await tab.screenshot({ path: resolve(outDir, "proof-inspector-side-by-side.png") });
console.log(`wrote ${resolve(outDir, "proof-inspector-side-by-side.png")}`);

await browser.close();
server.close();
