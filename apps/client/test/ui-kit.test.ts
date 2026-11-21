/**
 * The style kit's two guarantees, enforced.
 *
 * 1. Contrast. Every text colour in tokens.css meets its floor against the
 *    surface it is used on. A palette change that makes text unreadable
 *    fails here instead of shipping. The gain/loss colours on parchment
 *    were at 1.11:1 before this check existed, which is why it exists.
 *
 * 2. Determinism. The committed textures are exactly what
 *    generate-textures.mjs produces. If they ever diverge, the generator
 *    has stopped being the source of truth and the textures have quietly
 *    become hand-managed pictures — the thing the kit is meant to avoid.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Compiled to dist/test/ui-kit.test.js, so the client root is two up.
const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const kitDir = resolve(clientRoot, "src/ui/kit");

describe("style kit", () => {
  it("every text colour meets its contrast floor", () => {
    // check-contrast.mjs exits non-zero and prints the offending pairings.
    const out = execFileSync(process.execPath, [resolve(kitDir, "check-contrast.mjs")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(out, /pairings pass/, out);
  });

  it("the committed textures are what the generator produces", () => {
    const committed = readdirSync(resolve(kitDir, "textures")).filter((f) => f.endsWith(".png")).sort();
    assert.ok(committed.length > 0, "no textures committed");

    const tmp = mkdtempSync(resolve(tmpdir(), "kit-tex-"));
    try {
      // The generator writes beside itself, so regenerate into a copy and
      // compare bytes rather than trusting a timestamp.
      const gen = readFileSync(resolve(kitDir, "generate-textures.mjs"), "utf8").replace(
        'resolve(dirname(fileURLToPath(import.meta.url)), "textures")',
        JSON.stringify(tmp),
      );
      const genPath = resolve(tmp, "gen.mjs");
      // eslint-disable-next-line n/no-sync
      execFileSync(process.execPath, ["--input-type=module", "-e", gen], { stdio: "ignore" });
      void genPath;

      const made = readdirSync(tmp).filter((f) => f.endsWith(".png")).sort();
      assert.deepEqual(made, committed, "generator and repo disagree on which textures exist");

      for (const f of committed) {
        const a = readFileSync(resolve(kitDir, "textures", f));
        const b = readFileSync(resolve(tmp, f));
        assert.ok(a.equals(b), `${f} differs from what generate-textures.mjs produces`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
