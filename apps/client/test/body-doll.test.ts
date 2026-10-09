import "./strings-setup.js";
/**
 * Body doll: which parts count as injured, their order and their lines.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BodyMessage } from "@mmo-engine/protocol";
import { injuries, injuryText, isHurt, treatable } from "../src/ui/body-doll.js";

type Part = BodyMessage["parts"][number];
const part = (id: string, o: Partial<Part> = {}): Part => ({ id, name: id, hp: 1, state: "healthy", bleeding: false, ...o });
const body = (parts: Part[], blood = 100): BodyMessage => ({ kind: "body", entity: "7", parts, blood, bloodMax: 100 });

describe("isHurt", () => {
  it("is false for a whole body with full blood", () => {
    assert.equal(isHurt(null), false);
    assert.equal(isHurt(body([part("torso"), part("head")])), false);
  });

  it("is true for a hurt part, a wound or lost blood", () => {
    assert.equal(isHurt(body([part("torso", { hp: 0.8 })])), true);
    assert.equal(isHurt(body([part("torso", { bleeding: true })])), true);
    assert.equal(isHurt(body([part("torso")], 90)), true);
  });
});

describe("injuries", () => {
  it("lists the worst first: lost, maimed, harmed, bleeding, then by health", () => {
    const b = body([
      part("a", { hp: 0.9 }),
      part("b", { state: "harmed", hp: 0.3 }),
      part("c", { state: "dismembered", hp: 0, bleeding: true }),
      part("d", { hp: 0.7, bleeding: true }),
      part("e", { state: "maimed", hp: 0.2 }),
      part("f"),
    ]);
    assert.deepEqual(injuries(b).map((p) => p.id), ["c", "e", "b", "d", "a"]);
  });
});

describe("injuryText", () => {
  it("names the part, its state, a wound and the health left", () => {
    assert.equal(injuryText(part("Left leg", { state: "maimed", hp: 0.34, bleeding: true })), "Left leg maimed, bleeding (34%)");
    assert.equal(injuryText(part("Torso", { hp: 0.8 })), "Torso bruised (80%)");
    assert.equal(injuryText(part("Left hand", { state: "dismembered", hp: 0 })), "Left hand lost");
  });
});

describe("treatable", () => {
  it("offers treatment for injured parts and bleeding stumps only", () => {
    assert.equal(treatable(part("a")), false);
    assert.equal(treatable(part("a", { state: "harmed", hp: 0.3 })), true);
    assert.equal(treatable(part("a", { state: "dismembered", hp: 0, bleeding: true })), true);
    assert.equal(treatable(part("a", { state: "dismembered", hp: 0 })), false);
  });
});
