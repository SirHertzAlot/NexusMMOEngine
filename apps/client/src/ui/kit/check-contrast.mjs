/**
 * The kit's contrast guarantee, enforced.
 *
 * tokens.css claims a minimum contrast ratio for every text colour against
 * the surface it is used on. A claim in a comment rots. This reads the
 * tokens out of tokens.css and checks each pairing against WCAG 2.1
 * contrast, so a palette change that makes text unreadable fails the build
 * instead of shipping.
 *
 * Run: node apps/client/src/ui/kit/check-contrast.mjs
 * Exit code 1 and a table on any pairing below its floor.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "tokens.css"), "utf8");

/** Every `--kit-foo: #rrggbb;` in tokens.css. */
function tokens(src) {
  const out = new Map();
  for (const m of src.matchAll(/(--kit-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) out.set(m[1], m[2]);
  return out;
}

const T = tokens(css);

const luminance = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
};

const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * text token, surface token, floor.
 *
 * 4.5 is WCAG AA for body text. Titles are large enough for the 3.0 floor
 * but are held to 4.5 anyway: a game HUD is read in motion, over a moving
 * 3D scene, which is harder than a web page at rest.
 */
const PAIRS = [
  ["--kit-ink", "--kit-leather", 4.5],
  ["--kit-ink", "--kit-iron", 4.5],
  ["--kit-ink-soft", "--kit-leather", 4.5],
  ["--kit-ink-soft", "--kit-iron", 4.5],
  ["--kit-ink-dim", "--kit-leather", 4.5],
  ["--kit-ink-dark", "--kit-parchment", 4.5],
  ["--kit-ink-dark-soft", "--kit-parchment", 4.5],
  ["--kit-good", "--kit-leather", 4.5],
  ["--kit-bad", "--kit-leather", 4.5],
  ["--kit-warn", "--kit-leather", 4.5],
  // The tooltip and detail card are parchment, so gain/loss need the dark
  // pair there. Missing these is what let an unreadable green ship.
  ["--kit-good-dark", "--kit-parchment", 4.5],
  ["--kit-bad-dark", "--kit-parchment", 4.5],
  ["--kit-focus", "--kit-leather", 3.0], // a ring, not text: WCAG non-text floor
];

const rows = [];
let failed = 0;

for (const [textTok, surfTok, floor] of PAIRS) {
  const text = T.get(textTok);
  const surf = T.get(surfTok);
  if (!text || !surf) {
    rows.push(`MISSING  ${textTok} on ${surfTok} — token not found in tokens.css`);
    failed++;
    continue;
  }
  const r = ratio(text, surf);
  const ok = r >= floor;
  if (!ok) failed++;
  rows.push(`${ok ? "ok  " : "FAIL"}  ${textTok.padEnd(22)} on ${surfTok.padEnd(18)} ${r.toFixed(2)}:1  (floor ${floor})`);
}

console.log(rows.join("\n"));

if (failed > 0) {
  console.error(`\nstyle kit contrast: ${failed} pairing(s) below floor.`);
  process.exit(1);
}
console.log(`\nstyle kit contrast: ${PAIRS.length} pairings pass.`);
