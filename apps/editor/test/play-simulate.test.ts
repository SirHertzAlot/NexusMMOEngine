/**
 * TDD: Play Simulate mode — "World only, no player".
 * When where === "simulate", the server starts but no mirror client
 * connects. The world ticks; the editor shows status, not a game view.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultPlaySetup,
  shouldConnectPlayer,
  simulateLabel,
  type PlaySetup,
} from "../src/ui/play-setup.js";

const setup = (patch: Partial<PlaySetup>): PlaySetup => ({ ...defaultPlaySetup(), ...patch });

describe("simulate mode", () => {
  it("viewport mode connects a player", () => {
    assert.equal(shouldConnectPlayer(setup({ where: "viewport" })), true);
  });

  it("simulate mode does not connect a player", () => {
    assert.equal(shouldConnectPlayer(setup({ where: "simulate" })), false);
  });

  it("window mode connects a player (future: separate window)", () => {
    assert.equal(shouldConnectPlayer(setup({ where: "window" })), true);
  });

  it("labels simulate mode distinctly", () => {
    assert.ok(simulateLabel(setup({ where: "simulate" })).includes("Simulate"));
    assert.ok(!simulateLabel(setup({ where: "viewport" })).includes("Simulate"));
  });
});
