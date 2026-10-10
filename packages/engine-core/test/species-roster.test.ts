/**
 * The server's species roster: the built-in roster with the game's overlay
 * file over it, and only an edited species changes the open world's packs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SPECIES } from "@mmo-engine/species";
import { DEFAULT_SPECIES_FILE, editedPack, loadServerRoster } from "../src/species-roster.js";

const dir = mkdtempSync(join(tmpdir(), "mmo-roster-"));

describe("loadServerRoster", () => {
  it("is the built-in roster when there is no overlay, and leaves pack sizes to the creature rules", () => {
    const r = loadServerRoster(join(dir, "none.json"));
    assert.equal(r.roster, BUILTIN_SPECIES);
    assert.equal(r.edited.size, 0);
    assert.equal(editedPack(r, "goblin"), undefined);
  });

  it("merges the overlay over the built-ins, and an edited species sets its pack", () => {
    const file = join(dir, "species.json");
    writeFileSync(file, JSON.stringify({ goblin: { ...BUILTIN_SPECIES.goblin, name: "Cave goblin", pack: [7, 9] } }));
    const r = loadServerRoster(file);
    assert.equal(r.roster.goblin.name, "Cave goblin");
    assert.equal(r.roster.wolf.name, "Wolf");
    assert.deepEqual([...r.edited], ["goblin"]);
    assert.deepEqual(editedPack(r, "goblin"), [7, 9]);
    assert.equal(editedPack(r, "wolf"), undefined);
  });

  it("refuses a bad overlay, naming the file and every problem", () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ imp: { name: "Imp" } }));
    assert.throws(() => loadServerRoster(file), (e: Error) => e.message.includes("bad.json") && /imp/.test(e.message));
    writeFileSync(file, JSON.stringify({ goblin: { ...BUILTIN_SPECIES.goblin, pack: [5, 2] } }));
    assert.throws(() => loadServerRoster(file), /goblin\.pack: min above max/);
  });

  it("reads the repo's content/species/species.json when it exists (this file's default)", () => {
    assert.match(DEFAULT_SPECIES_FILE, /content[\\/]species[\\/]species\.json$/);
    assert.ok(Object.keys(loadServerRoster().roster).length >= Object.keys(BUILTIN_SPECIES).length);
  });
});
