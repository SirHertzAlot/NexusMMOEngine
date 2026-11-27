/**
 * What goes off with a module (roadmap EB9).
 *
 * The bug this slice fixes is the reason for the first few assertions: the
 * panel closed the enabled set one level deep, so disabling a module two
 * steps down a chain produced a set the host refuses. The closure has to be
 * transitive, the way `resolveModuleSet` checks it, and the question the
 * dialog asks has to list what the person is about to lose.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  blastRadius,
  blastSummary,
  dependentsOf,
  enabledAfterDisabling,
  needsConfirming,
  type BlastModule,
} from "../src/module-blast.js";
import { BlastDialog } from "../src/ui/blast-dialog.js";

/** core <- combat <- loot <- vendor, with an unrelated terrain module. */
const MODULES: BlastModule[] = [
  { name: "core", enabled: true, locked: true, dependsOn: [], systems: ["tick"] },
  { name: "combat", enabled: true, dependsOn: ["core"], systems: ["damage", "aggro"], editor: true },
  { name: "loot", enabled: true, dependsOn: ["combat"], systems: ["drops"] },
  { name: "vendor", enabled: true, dependsOn: ["loot"], systems: ["trade"], sidecar: true },
  { name: "terrain", enabled: true, dependsOn: ["core"], systems: ["erosion"] },
  { name: "weather", enabled: false, dependsOn: ["combat"], systems: ["storms"] },
];

describe("who goes with it", () => {
  it("follows the chain all the way down, nearest first", () => {
    assert.deepEqual(dependentsOf(MODULES, "combat"), ["loot", "vendor"]);
  });
  it("leaves modules that do not depend on it alone", () => {
    assert.equal(dependentsOf(MODULES, "combat").includes("terrain"), false);
  });
  it("ignores modules that are already off", () => {
    assert.equal(dependentsOf(MODULES, "combat").includes("weather"), false);
  });
  it("is empty for a leaf", () => {
    assert.deepEqual(dependentsOf(MODULES, "vendor"), []);
  });
});

describe("the set that gets saved", () => {
  const enabled = ["core", "combat", "loot", "vendor", "terrain"];
  it("drops the module and everything downstream in one go", () => {
    assert.deepEqual(enabledAfterDisabling(MODULES, enabled, "combat"), ["core", "terrain"]);
  });
  it("drops only the module when nothing depends on it", () => {
    assert.deepEqual(enabledAfterDisabling(MODULES, enabled, "terrain"), ["core", "combat", "loot", "vendor"]);
  });
});

describe("the radius", () => {
  const r = blastRadius(MODULES, "combat");
  it("counts the systems leaving the tick order, the module's own included", () => {
    assert.deepEqual(r.systems, ["damage", "aggro", "drops", "trade"]);
  });
  it("names the editor panels and sidecars that go", () => {
    assert.deepEqual(r.editorPanels, ["combat"]);
    assert.deepEqual(r.sidecars, ["vendor"]);
  });
  it("marks a locked module, which cannot be turned off at all", () => {
    assert.equal(blastRadius(MODULES, "core").locked, true);
    assert.equal(r.locked, false);
  });
  it("asks first only when other modules go too", () => {
    assert.equal(needsConfirming(r), true);
    assert.equal(needsConfirming(blastRadius(MODULES, "terrain")), false);
  });
});

describe("the line on the card", () => {
  it("says what the module is carrying", () => {
    assert.equal(blastSummary(blastRadius(MODULES, "combat")), "Turning this off takes 2 modules, 4 systems and 1 sidecar with it");
  });
  it("uses the singular where it should", () => {
    assert.equal(blastSummary(blastRadius(MODULES, "terrain")), "Turning this off takes 1 system with it");
  });
  it("says nothing when there is nothing to say", () => {
    assert.equal(blastSummary(blastRadius([{ name: "quiet", enabled: true, dependsOn: [], systems: [] }], "quiet")), null);
  });
});

describe("the dialog", () => {
  it("draws nothing without a radius", () => {
    assert.equal(renderToStaticMarkup(React.createElement(BlastDialog, { radius: null, onCancel: () => undefined, onConfirm: () => undefined })), "");
  });
  it("lists every module going, and what that costs", () => {
    const html = renderToStaticMarkup(
      React.createElement(BlastDialog, { radius: blastRadius(MODULES, "combat"), onCancel: () => undefined, onConfirm: () => undefined }),
    );
    assert.match(html, /Turn off combat\?/);
    assert.match(html, /2 other modules depend on it/);
    assert.match(html, /combat, loot, vendor/);
    assert.match(html, /damage, aggro, drops, trade/);
    assert.match(html, /Turn off 3/);
  });
});
