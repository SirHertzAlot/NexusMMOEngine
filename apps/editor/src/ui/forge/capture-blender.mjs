/**
 * Photograph the Blender live link with a model that actually arrived
 * (slice EU10).
 *
 * There is no Blender in a container, so the add-on cannot be the thing
 * that pushes here — but the route it pushes to can be exercised
 * exactly as the add-on exercises it: a POST of a .glb to
 * /api/editor/blender/push. Everything after that is the real path:
 * the host's checks, the write into assets/live, the index, the
 * panel's poll and the editor's own ModelPreview.
 *
 *   npm run dev --workspace apps/editor      # in another terminal
 *   CHROMIUM_PATH=/opt/pw-browsers/chromium \
 *     node apps/editor/src/ui/forge/capture-blender.mjs <out-dir> [url]
 */

import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const out = resolve(process.argv[2] ?? "/tmp/forge-blender");
const base = (process.argv[3] ?? "http://localhost:5174").replace(/\/$/, "");
mkdirSync(out, { recursive: true });

// A committed test fixture, not licensed art: the crate stands in for
// whatever the designer had selected in Blender.
const model = readFileSync(resolve("packages/art/test/fixtures/baselines/prop-crate.glb"));

const push = async (name, from) => {
  const res = await fetch(`${base}/api/editor/blender/push?name=${name}&from=${from}`, {
    method: "POST",
    headers: { "Content-Type": "model/gltf-binary" },
    body: model,
  });
  const body = await res.json();
  console.log(`push ${name}: ${res.status} ${JSON.stringify(body.model ?? body.error)}`);
  if (!res.ok) process.exit(1);
};

await push("crate", "props.blend");
await push("crate-damaged", "props.blend");
await push("crate", "props.blend"); // a re-push: one entry, two pushes

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${base}/?theme=forge`, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
// The workspace strip is buttons in a nav, the view strip is a tablist.
await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: /Art & audio/i }).click();
await page.waitForTimeout(1500);
await page.getByRole("tab", { name: /Blender link/i }).first().click();
await page.waitForTimeout(5000);

const file = resolve(out, "eu10-blender-link.png");
await page.screenshot({ path: file });
console.log(`wrote ${file}`);

await browser.close();
if (errors.length > 0) {
  console.error("page errors:", errors.slice(0, 10));
  process.exit(1);
}
console.log("no page errors");
