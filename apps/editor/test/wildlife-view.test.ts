/**
 * The Gameplay grids' read-only wildlife view: the table as the game loads it
 * (engine-core's loader and checks), flattened per species, served at
 * GET /api/editor/gameplay/wildlife. Saving stays in the content files.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { handleGameplay } from "../src/gameplay-host.js";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

describe("GET /api/editor/gameplay/wildlife", () => {
  it("lists every species with the numbers the game reads, and the table's checks", async () => {
    const r = await handleGameplay(REPO, { method: "GET", route: "wildlife", body: {} });
    assert.equal(r.status, 200);
    const body = r.body as { ok: boolean; species: Array<Record<string, unknown>>; problems: string[]; biomes: string[] };
    assert.equal(body.ok, true);
    assert.deepEqual(body.problems, [], "the shipped table passes its own checks");
    const by = new Map(body.species.map((s) => [s.id as string, s]));
    const deer = by.get("deer");
    assert.ok(deer, "deer is listed");
    assert.equal(deer.wanderM, 12);
    assert.equal(deer.temperament, "flee");
    assert.equal(deer.raidRangeM, null, "a non-raider has no raid range");
    const coyote = by.get("coyote");
    assert.equal(coyote?.temperament, "raid");
    assert.equal(coyote?.raidRangeM, 900);
    assert.ok(body.biomes.includes("plains"));
  });

  it("is read only: other methods on the route are refused", async () => {
    const r = await handleGameplay(REPO, { method: "POST", route: "wildlife", contentType: "application/json", body: {} });
    assert.equal(r.status, 404);
  });
});
