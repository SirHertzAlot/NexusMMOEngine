/**
 * The server's species roster: the sample pack with the game's overlay file
 * over it, and only an edited species changes the open world's packs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpecies } from "@mmo-engine/species";
import { DEFAULT_SPECIES_FILE, editedPack, loadServerRoster } from "../src/species-roster.js";

const dir = mkdtempSync(join(tmpdir(), "mmo-roster-"));

describe("loadServerRoster", () => {
  it("is the sample pack when there is no overlay, and leaves pack sizes to the creature rules", () => {
    const r = loadServerRoster(join(dir, "none.json"));
    assert.deepEqual(Object.keys(r.roster).sort(), Object.keys(loadSpecies()).sort());
    assert.equal(r.edited.size, 0);
    assert.equal(editedPack(r, "goblin"), undefined);
  });

  it("merges the overlay over the sample pack, and an edited species sets its pack", () => {
    const base = loadSpecies();
    const file = join(dir, "species.json");
    writeFileSync(file, JSON.stringify({ goblin: { ...base.goblin, name: "Cave goblin", pack: [7, 9] } }));
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
    writeFileSync(file, JSON.stringify({ goblin: { ...loadSpecies().goblin, pack: [5, 2] } }));
    assert.throws(() => loadServerRoster(file), /goblin\.pack: min above max/);
  });

  it("reads the repo's content/species/species.json by default", () => {
    assert.match(DEFAULT_SPECIES_FILE, /content[\\/]species[\\/]species\.json$/);
    assert.deepEqual(Object.keys(loadServerRoster().roster).sort(), Object.keys(loadSpecies()).sort());
  });
});
