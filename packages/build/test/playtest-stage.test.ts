/**
 * TDD: EA26 pipeline integration — playtests as a build-pipeline stage.
 *
 * The default profile gains a `playtest` stage (after `test`): it runs
 * `npm run playtest`, which executes every scenario in content/playtests/.
 * A failing scenario fails the pipeline, and its replay is saved for
 * tick-for-tick reproduction.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultProfile, loadProfile } from "../src/profile.js";

describe("playtest stage", () => {
  it("the default profile includes a playtest stage", () => {
    const p = defaultProfile();
    const stage = p.stages.find((s) => s.id === "playtest");
    assert.ok(stage, "default profile has no playtest stage");
    assert.match(stage.command, /playtest/);
  });

  it("the playtest stage runs after the test stage", () => {
    const p = defaultProfile();
    const ids = p.stages.map((s) => s.id);
    assert.ok(ids.indexOf("playtest") > ids.indexOf("test"), "playtest must run after test");
  });

  it("the playtest stage watches the scenarios and the runner", () => {
    const p = defaultProfile();
    const stage = p.stages.find((s) => s.id === "playtest")!;
    assert.ok(stage.inputs.some((i) => i.includes("playtests")), "stage should watch content/playtests");
    assert.ok(stage.inputs.some((i) => i.includes("playtest")), "stage should watch the runner");
  });

  it("a custom profile can add the playtest stage", () => {
    const p = loadProfile({
      name: "quick",
      stages: [
        { id: "build", command: "npm run build", inputs: ["package.json"] },
        { id: "playtest", command: "npm run playtest", inputs: ["content/playtests"] },
      ],
    });
    assert.equal(p.stages[1]!.id, "playtest");
  });
});
