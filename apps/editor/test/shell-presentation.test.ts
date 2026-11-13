/**
 * The shell presentation follows its pins (T2 follow-up): a pin move notifies and re-composes, a presentation is
 * its own, and the clock is injectable.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LEGACY_SHELL_TEMPLATE_ID, SHELL_TEMPLATE_ID, type Provenance } from "../src/authoring/index.js";
import { createShellPresentation } from "../src/ui/shell-presentation.js";
import { SHELL } from "../src/ui/shell-composition.js";

const prov: Provenance = { who: { id: "joey", role: "designer" }, what: "shell slot presentation", when: 1, where: "Editor shell", why: "test" };

describe("shell presentation", () => {
  it("notifies on a pin move and a rollback, only for the shell slot, and stops after unsubscribe", () => {
    const p = createShellPresentation();
    let n = 0;
    const off = p.subscribe(() => n++);
    p.pins.pin("shell", { templateId: LEGACY_SHELL_TEMPLATE_ID, version: 1 }, prov, p.registry);
    assert.equal(n, 1);
    p.pins.rollback("shell", prov, p.registry);
    assert.equal(n, 2);
    p.pins.pin("authoring", { templateId: "viewport-authoring", version: 1 }, prov, p.registry);
    assert.equal(n, 2, "another slot's pin is not the shell's business");
    off();
    p.pins.pin("shell", { templateId: LEGACY_SHELL_TEMPLATE_ID, version: 1 }, prov, p.registry);
    assert.equal(n, 2);
  });

  it("re-composes when the pin moves, and gives the same object while nothing changed (a UI snapshot)", () => {
    const p = createShellPresentation();
    const a = p.composition();
    assert.equal(p.composition(), a, "stable by identity");
    assert.ok(a.has(SHELL.toolBar) && a.hasDock("left"));
    p.pins.pin("shell", { templateId: LEGACY_SHELL_TEMPLATE_ID, version: 1 }, prov, p.registry);
    const b = p.composition();
    assert.notEqual(b, a);
    assert.equal(b.has(SHELL.toolBar), false, "the legacy shell has no tool bar");
    p.pins.rollback("shell", prov, p.registry);
    assert.ok(p.composition().has(SHELL.toolBar), "rolled back");
    assert.equal(p.resolve().template.id, SHELL_TEMPLATE_ID);
  });

  it("is its own: pins in one presentation do not move another", () => {
    const a = createShellPresentation();
    const b = createShellPresentation();
    a.pins.pin("shell", { templateId: LEGACY_SHELL_TEMPLATE_ID, version: 1 }, prov, a.registry);
    assert.equal(a.composition().has(SHELL.toolBar), false);
    assert.equal(b.composition().has(SHELL.toolBar), true);
  });

  it("stamps its bootstrap provenance from the clock it is given, not a made-up date", () => {
    const p = createShellPresentation(() => 424242);
    assert.equal(p.pins.pinHistory()[0]!.provenance.when, 424242);
    assert.ok(createShellPresentation().pins.pinHistory()[0]!.provenance.when > 1_700_000_000_000);
  });
});
