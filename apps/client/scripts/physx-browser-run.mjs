// Serves the repo, opens physx-browser-bench.html in headless Chromium, and
// writes the result to --out (default: /tmp/claude/physx-browser-results.json).
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = normalize(join(dirname(fileURLToPath(import.meta.url)), "../../.."));
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
const outIdx = process.argv.indexOf("--out");
const out = outIdx >= 0 ? process.argv[outIdx + 1] : "/tmp/claude/physx-browser-results.json";

const server = createServer(async (req, res) => {
  try {
    const path = normalize(join(root, decodeURIComponent(new URL(req.url, "http://x").pathname)));
    if (!path.startsWith(root)) throw new Error("outside repo");
    const body = await readFile(path);
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
try {
  const libs = (process.env.LIBS ?? "rapier,jolt,physx").split(",");
  const merged = { env: "chromium", libs: {} };
  for (const lib of libs) {
    const page = await browser.newPage();
    page.on("pageerror", (e) => process.stderr.write(`[${lib}] pageerror: ${e.message}\n`));
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/apps/client/scripts/physx-browser-bench.html?lib=${lib}`);
    try {
      await page.waitForFunction(() => window.__physicsBench, null, { timeout: 15 * 60 * 1000, polling: 2000 });
      const result = await page.evaluate(() => window.__physicsBench);
      if (result.error) throw new Error(result.error);
      merged.libs[lib] = result.libs[lib];
      merged.scene = result.scene;
      process.stdout.write(`[${lib}] done in ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
    } catch (e) {
      merged.libs[lib] = { notMeasured: String(e.message ?? e).slice(0, 300) };
      process.stdout.write(`[${lib}] NOT MEASURED: ${String(e.message ?? e).slice(0, 200)}\n`);
    }
    await writeFile(out, JSON.stringify(merged, null, 2));
    await page.close();
  }
  process.stdout.write(`wrote ${out}\n`);
} finally {
  await browser.close();
  server.close();
}
