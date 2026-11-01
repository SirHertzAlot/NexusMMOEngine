#!/usr/bin/env node
/**
 * Editor load smoke: start the editor's Vite dev server, open the page in
 * headless Chromium, and fail on any uncaught page error, any React
 * "change in the order of Hooks" warning, or a toolbar that never renders.
 *
 * Guards the editor shell against render-time regressions such as the
 * React Compiler reordering hooks behind a store's `.use()` call (the
 * Toolbar and Snackbar crash on main, fixed by naming store reads `useValue()`).
 *
 * Prereqs: `npm install` at the root (Playwright and the pre-installed
 * Chromium) and the editor's workspace deps (`npm run build:deps` in apps/editor).
 *
 * Usage: node scripts/editor-load-smoke.mjs
 *   EDITOR_SMOKE_PORT (default 5176), EDITOR_SMOKE_CHROMIUM (default /opt/pw-browsers/chromium
 *   when it exists, otherwise Playwright's own browser).
 *
 * Exit 0 = the editor loaded with no page error and its toolbar rendered.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const editorDir = path.join(root, "apps", "editor");
const PORT = Number(process.env.EDITOR_SMOKE_PORT ?? 5176);
const URL_ = `http://127.0.0.1:${PORT}/`;
const DEFAULT_CHROMIUM = "/opt/pw-browsers/chromium";
const executablePath = process.env.EDITOR_SMOKE_CHROMIUM ?? (fs.existsSync(DEFAULT_CHROMIUM) ? DEFAULT_CHROMIUM : undefined);

const failures = [];
const log = (msg) => console.log(`[editor-load-smoke] ${msg}`);

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`editor dev server did not answer at ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const vite = spawn(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--port", String(PORT), "--strictPort"], {
  cwd: editorDir,
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOut = "";
vite.stdout.on("data", (d) => (viteOut += d));
vite.stderr.on("data", (d) => (viteOut += d));

let browser;
try {
  await waitForServer(URL_);
  log(`dev server up at ${URL_}`);
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && /change in the order of Hooks/.test(m.text())) failures.push("React hook-order warning");
  });
  await page.goto(URL_, { waitUntil: "load" });
  try {
    await page.locator('[aria-label="Edit tools"]').first().waitFor({ state: "visible", timeout: 30_000 });
    log("toolbar rendered");
  } catch {
    failures.push("the toolbar never rendered (aria-label=\"Edit tools\")");
  }
  // Give late effects a chance to throw before judging.
  await page.waitForTimeout(1500);
} catch (err) {
  failures.push(String(err?.message ?? err));
} finally {
  if (browser) await browser.close();
  vite.kill("SIGTERM");
}

if (failures.length > 0) {
  console.error(`[editor-load-smoke] FAILED:\n  - ${failures.join("\n  - ")}`);
  if (viteOut.trim()) console.error(viteOut.slice(-2000));
  process.exit(1);
}
log("PASS: editor loaded with no page error and no hook-order warning");
