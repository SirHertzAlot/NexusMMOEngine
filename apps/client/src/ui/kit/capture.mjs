/**
 * Before/after captures for the style kit.
 *
 * Bundles preview.tsx (which mounts the real BagPanel and the real
 * BagPanelKit on one fixture bag), serves it, and screenshots each panel
 * on its own plus the pair together. The shots are evidence, so nothing
 * here touches the components: it only renders and photographs them.
 *
 * Run: node apps/client/src/ui/kit/capture.mjs [outDir]
 * Default outDir: /mnt/project-files/marketing/client-ui
 *
 * Needs the workspace installed (esbuild and playwright come with it) and
 * the generated textures present (generate-textures.mjs).
 */

import { build } from "esbuild";
import { chromium } from "playwright";
import http from "node:http";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..", "..");
const outDir = process.argv[2] ?? "/mnt/project-files/marketing/client-ui";

const strings = JSON.parse(readFileSync(resolve(repoRoot, "content/strings/en.json"), "utf8"));

// ------------------------------------------------------------------ bundle

const bundled = await build({
  entryPoints: [resolve(here, "preview.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  target: "chrome120",
  loader: { ".tsx": "tsx", ".ts": "ts", ".png": "dataurl", ".css": "css" },
  define: { __STRINGS__: JSON.stringify({ en: strings }), "process.env.NODE_ENV": '"production"' },
  absWorkingDir: repoRoot,
  logLevel: "warning",
});

// With write:false and one entry, esbuild names the JS output "<stdout>",
// so pick by "not the css file" rather than by extension.
const bundledCss = bundled.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
const js = bundled.outputFiles.find((f) => !f.path.endsWith(".css"))?.text ?? "";
if (!js) throw new Error("preview bundle came out empty");

// The "before" panel is Tailwind-classed, so the Before shot has to be the
// client's REAL Tailwind output, not an approximation of it. Run the
// client's own Tailwind with the client's own config and app.css over the
// panel's source. Anything else would be comparing the kit against a
// strawman.
const clientRoot = resolve(here, "..", "..", "..");
const beforeCss = execFileSync(
  resolve(repoRoot, "node_modules/.bin/tailwindcss"),
  ["-c", resolve(clientRoot, "tailwind.config.js"), "-i", resolve(clientRoot, "src/app.css"), "--minify"],
  { cwd: clientRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
const tokensCss = readFileSync(resolve(here, "tokens.css"), "utf8");
const kitCss = readFileSync(resolve(here, "kit.css"), "utf8");

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>${beforeCss}</style>
<style>${tokensCss}</style>
<style>${kitCss}</style>
<style>${bundledCss}</style>
<style>
  html, body { margin: 0; background: #11131a; }
  .sheet { display: flex; gap: 40px; padding: 32px; align-items: flex-start; font-family: system-ui, sans-serif; }
  .pane__title { color: #e8eaf0; font: 600 17px/1.2 system-ui, sans-serif; margin-bottom: 2px; }
  .pane__note { color: #8e94a6; font: 400 12px/1.3 system-ui, sans-serif; margin-bottom: 14px; }
  .pane__stage { display: inline-block; }
  .sheet--kit { padding-top: 0; }
  /* Capture-only: the sheet shows hover and pressed side by side, which a
     still cannot do with real pointer state. These mirror kit.css exactly. */
  .kit-btn.hover-demo {
    background-image: linear-gradient(180deg, var(--kit-bronze-light) 0%, var(--kit-bronze-light) 48%, var(--kit-bronze) 48%, var(--kit-bronze) 100%);
  }
  .kit-btn.active-demo {
    transform: translate(var(--kit-bevel), var(--kit-bevel));
    box-shadow: inset -1px -1px 0 0 var(--kit-bronze-light), inset 1px 1px 0 0 var(--kit-bronze-shadow);
  }
  .kit-sheetpanel { width: 332px; }
  .swatches { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--kit-space-1); margin: var(--kit-space-1) 0; }
  .swatch { display: flex; align-items: flex-end; height: 48px; padding: 4px 6px; border-radius: var(--kit-radius); border: 1px solid var(--kit-bronze-shadow); }
  .kit-swatch-frame { border-width: 8px; border-image-slice: 14; }
  .kit-slotstates { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--kit-space-1); }
  .kit-slotstates .kit-slot--cell { aspect-ratio: auto; height: 34px; }
  .kit-sheet-tooltip { position: static; width: auto; padding: var(--kit-space-1) var(--kit-space-2); }
</style>
</head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;

// ------------------------------------------------------------------ serve

const srv = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (u === "/" || u === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  if (u === "/bundle.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    return res.end(js);
  }
  const f = join(here, u);
  if (!f.startsWith(here) || !existsSync(f)) {
    res.writeHead(404);
    return res.end();
  }
  const types = { ".png": "image/png", ".css": "text/css", ".js": "text/javascript" };
  res.writeHead(200, { "Content-Type": types[extname(f)] ?? "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;

// ----------------------------------------------------------------- capture

mkdirSync(outDir, { recursive: true });

// The repo pins its own playwright, whose browser build may not be the one
// installed in the image. Prefer the image's Chromium when it is there.
const SYS_CHROMIUM = "/opt/pw-browsers/chromium";
const browser = await chromium.launch({
  args: ["--no-sandbox"],
  ...(existsSync(SYS_CHROMIUM) ? { executablePath: SYS_CHROMIUM } : {}),
});
// deviceScaleFactor 2: these are read by people, not measured in px.
const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });

// The browser always asks for a favicon the harness does not serve; that
// 404 is noise, and letting it fail the run would hide real failures.
const problems = [];
const ignorable = (s) => s.includes("favicon.ico");
page.on("pageerror", (e) => !ignorable(e.message) && problems.push("pageerror: " + e.message));
// A console error names its URL in location(), not in text().
page.on("console", (m) => {
  if (m.type() !== "error") return;
  if (ignorable(m.text()) || ignorable(m.location()?.url ?? "")) return;
  problems.push("console: " + m.text());
});
page.on("requestfailed", (r) => !ignorable(r.url()) && problems.push("requestfailed: " + r.url()));
page.on("response", (r) => r.status() >= 400 && !ignorable(r.url()) && problems.push(`http ${r.status()}: ${r.url()}`));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
await page.waitForSelector(".kit-bagpanel", { timeout: 15000 });
// Let the textures decode before shooting.
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(600);

const shots = [];
async function shoot(selector, name) {
  const el = await page.$(selector);
  if (!el) {
    problems.push(`missing selector ${selector}`);
    return;
  }
  await el.screenshot({ path: resolve(outDir, name) });
  shots.push(name);
}

await shoot(".sheet .pane:nth-child(1) .pane__stage", "bag-panel-before.png");
await shoot(".sheet .pane:nth-child(2) .pane__stage", "bag-panel-after.png");
await shoot(".sheet--kit .pane__stage", "style-kit-sheet.png");
await shoot(".sheet:not(.sheet--kit)", "bag-panel-side-by-side.png");

await browser.close();
srv.close();

console.log(`style kit captures -> ${outDir}`);
for (const s of shots) console.log("  " + s);
if (problems.length) {
  console.error("\npage problems:\n  " + problems.slice(0, 10).join("\n  "));
  process.exit(1);
}
