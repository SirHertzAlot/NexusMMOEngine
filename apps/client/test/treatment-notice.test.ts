/**
 * Treatment notices (M4, 0x1a): what the healer and the patient read.
 */

import "./i18n-setup.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TreatmentMessage } from "@mmo-engine/protocol";
import { treatmentNotice } from "../src/ui/treatment-notice.js";

const msg = (over: Partial<TreatmentMessage>): TreatmentMessage => ({
  kind: "treatment",
  healer: "1",
  patient: "1",
  part: "legLeft",
  treatment: "bandage",
  state: "started",
  ...over,
});

describe("treatmentNotice", () => {
  it("speaks to a player treating themselves", () => {
    assert.equal(treatmentNotice(msg({ seconds: 3.6 }), "1", "Left leg"), "Bandaging your left leg (4 s)");
    assert.equal(treatmentNotice(msg({ state: "done" }), "1", "Left leg"), "You bandaged your left leg");
    assert.equal(treatmentNotice(msg({ state: "failed", treatment: "set" }), "1", "Left leg"), "You failed to set your left leg");
    assert.equal(treatmentNotice(msg({ state: "stopped" }), "1"), "Treatment stopped");
  });

  it("speaks to a healer and a patient", () => {
    const other = { patient: "2" };
    assert.equal(treatmentNotice(msg({ ...other, treatment: "stump" }), "1", "Left hand"), "Closing the stump of their left hand");
    assert.equal(treatmentNotice(msg({ ...other, treatment: "stump" }), "2", "Left hand"), "Someone is closing the stump of your left hand");
    assert.equal(treatmentNotice(msg({ ...other, state: "done" }), "2", "Left leg"), "Your left leg is treated");
    assert.equal(treatmentNotice(msg({ ...other, state: "stopped" }), "2"), null);
  });
});
