/**
 * Photograph the RUNNING editor's bottom dock (slice EU5).
 *
 * The other three harnesses in this folder render components over
 * fixtures, which is right for a panel whose data needs no server. The
 * dock's regrouping is not that: what it claims is that four tabs over
 * the real shell reach everything the three Material 3 tabs reached,
 * and only the running app can show it. So this one drives the real dev
 * server.
 *
 *   npm run dev --workspace apps/editor      # in another terminal
 *   CHROMIUM_PATH=/opt/pw-browsers/chromium \
 *     node apps/editor/src/ui/forge/capture-dock.mjs <out-dir> [url]
 *
 * It fails loudly on a page error, because a screenshot of a shell that
 * threw is worse than no screenshot: it looks like proof.
 */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const out = resolve(process.argv[2] ?? "/tmp/forge-dock");
const base = process.argv[3] ?? "http://localhost:5174/";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 2 });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const url = new URL(base);
url.searchParams.set("theme", "forge");
await page.goto(url.toString(), { waitUntil: "networkidle" });
await page.waitForTimeout(4000);

// Each of the four, in the order the dock draws them.
for (const label of ["Console", "Problems", "Source Control", "Integrations"]) {
  const tab = page.getByRole("tab", { name: new RegExp(label, "i") }).last();
  if ((await tab.count()) === 0) {
    console.error(`no dock tab: ${label}`);
    continue;
  }
  await tab.click();
  await page.waitForTimeout(900);
  const file = resolve(out, `eu5-dock-${label.toLowerCase().replace(/\s+/g, "-")}.png`);
  await page.screenshot({ path: file });
  console.log(`wrote ${file}`);
}

await browser.close();
if (errors.length > 0) {
  console.error("page errors:", errors.slice(0, 10));
  process.exit(1);
}
console.log("no page errors");
