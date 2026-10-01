/** BagPanel helpers (M3a): stats read in a fixed order, zeros left out. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { statLines } from "../src/ui/bag-panel.js";

describe("statLines", () => {
  it("orders known stats first, then the rest alphabetically, dropping zeros", () => {
    assert.deepEqual(statLines({ fire: 3, crit: 5, power: 12, armour: 0, lifesteal: 2 }), [
      ["power", 12],
      ["crit", 5],
      ["fire", 3],
      ["lifesteal", 2],
    ]);
  });
});
