/**
 * The theme covers the primitives too (roadmap EB4b).
 *
 * `forge.css` restyles the editor by redefining roles rather than by
 * rewriting components, which works only while every variable a component
 * reads is actually redefined. The legacy shadcn aliases were not: every
 * `Button`, `Input` and `Select` in `ui/components.tsx` reads
 * `--primary` / `--background` / `--input`, so the Scenes workspace stayed
 * Material 3 purple on a dark forge panel. This test reads both
 * stylesheets and fails if an alias the default theme defines is missing
 * from the forge block — the same failure, found before a screenshot does.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Compiled from apps/editor/dist/test.
const editorRoot = fileURLToPath(new URL("../../", import.meta.url));
const appCss = readFileSync(`${editorRoot}src/app.css`, "utf8");
const forgeCss = readFileSync(`${editorRoot}src/forge.css`, "utf8");

/** The custom properties declared in a block, by name. */
function declaredIn(css: string, selector: string): Set<string> {
  const at = css.indexOf(selector);
  assert.notEqual(at, -1, `${selector} is missing`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("\n}", open);
  const body = css.slice(open, close);
  return new Set([...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

const root = declaredIn(appCss, ":root");
const forge = declaredIn(forgeCss, '[data-theme="forge"]');

/** The aliases ui/components.tsx reads through the Tailwind-style utilities. */
const ALIASES = [
  "--background",
  "--foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--input",
  "--ring",
];

describe("the forge theme and the shadcn aliases", () => {
  it("the aliases this test names really are the default theme's", () => {
    for (const name of ALIASES) assert.ok(root.has(name), `${name} is not declared in :root`);
  });

  it("redefines every alias the default theme declares", () => {
    const missing = [...root].filter((name) => name.startsWith("--") && !name.startsWith("--m3-font") && !forge.has(name));
    // Only the type scale may differ: forge maps the fonts through --fg-font-*.
    assert.deepEqual(missing, [], `the forge theme leaves these at their default: ${missing.join(", ")}`);
  });

  it("keeps each alias in the channel space app.css reads it in", () => {
    const value = (css: string, selector: string, name: string): string => {
      const at = css.indexOf(selector);
      const body = css.slice(at, css.indexOf("\n}", at));
      return new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim() ?? "";
    };
    // hsl() in app.css, so these carry percentages.
    for (const name of ["--border", "--input", "--ring"]) {
      assert.match(value(forgeCss, '[data-theme="forge"]', name), /%/, `${name} is read through hsl()`);
    }
    // rgb() in app.css, so these are plain channels.
    for (const name of ["--background", "--primary", "--accent"]) {
      assert.match(value(forgeCss, '[data-theme="forge"]', name), /^\d+ \d+ \d+$/, `${name} is read through rgb()`);
    }
  });
});
