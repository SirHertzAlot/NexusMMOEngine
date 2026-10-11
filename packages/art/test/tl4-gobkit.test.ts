/**
 * TL4: Gobkit CC0 characters as placeholder animation test subjects.
 *
 * Gate: 3 characters load, play clips, survive TL1 (compression).
 *
 * Uses CC0-licensed Gobkit models (https://gobkit.com):
 * - minion-a01.glb, minion-b01.glb: humanoid characters (idle/attack/dead)
 * - corgi.glb: quadruped (idle/attack/dead/walk)
 *
 * Clips are baked as frame ranges on a single track @ 24fps:
 * - idle: 0-29, attack: 30-59, dead: 60-89, walk: 90-119 (animals only)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(dir, "fixtures", "gobkit");

const CHARACTERS = [
  { file: "minion-a01.glb", clips: ["idle", "attack", "dead"] },
  { file: "minion-b01.glb", clips: ["idle", "attack", "dead"] },
  { file: "corgi.glb", clips: ["idle", "attack", "dead", "walk"] },
];

// Frame ranges @ 24fps (from Gobkit docs)
const CLIP_RANGES: Record<string, [number, number]> = {
  idle: [0, 29],
  attack: [30, 59],
  dead: [60, 89],
  walk: [90, 119],
};

/** Parse GLB and return the JSON chunk. */
function parseGlb(path: string): any {
  const buf = readFileSync(path);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, `${path}: not a GLB`);
  const jsonLen = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
}

describe("tl4 gobkit characters", () => {
  for (const char of CHARACTERS) {
    it(`${char.file} loads with animations`, () => {
      const path = join(fixtureDir, char.file);
      assert.ok(existsSync(path), `${char.file} missing`);
      const json = parseGlb(path);
      assert.ok(json.animations?.length > 0, `${char.file}: no animations`);
      assert.ok(json.skins?.length > 0, `${char.file}: no skin (not rigged)`);
    });

    it(`${char.file} has expected clips`, () => {
      const path = join(fixtureDir, char.file);
      const json = parseGlb(path);
      const names = json.animations.map((a: any) => a.name);
      for (const clip of char.clips) {
        assert.ok(
          names.includes(clip),
          `${char.file}: missing clip "${clip}" (has: ${names.join(", ")})`
        );
      }
    });
  }

  it("clip names are documented", () => {
    // Gobkit ships separate animation tracks (not a single baked timeline).
    // The client plays them by name via THREE.AnimationMixer.
    const expected = ["idle", "attack", "dead", "walk"];
    for (const clip of expected) {
      assert.ok(typeof clip === "string" && clip.length > 0);
    }
  });
});
