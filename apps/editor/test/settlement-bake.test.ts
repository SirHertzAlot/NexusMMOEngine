/**
 * The editor's bake request: checked before anything reaches the bake CLI, and turned into its arguments.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bakeArgs, parseBakeBody } from "../src/settlement-host.js";

const ok = { id: "0004", seed: 1234, population: 600, site: 2 };

describe("editor town bake request", () => {
  it("accepts a whole, in-range request", () => {
    assert.deepEqual(parseBakeBody(JSON.stringify(ok)), ok);
  });

  it("refuses anything out of range or not whole, before the CLI runs", () => {
    const bad: Array<Record<string, unknown>> = [
      { ...ok, id: "4" },
      { ...ok, id: "../x" },
      { ...ok, seed: -1 },
      { ...ok, seed: 1.5 },
      { ...ok, population: 0 },
      { ...ok, population: 5001 },
      { ...ok, site: 0 },
      { ...ok, site: "1" },
      { id: "0004" },
    ];
    for (const b of bad) assert.throws(() => parseBakeBody(JSON.stringify(b)), /need \{/, JSON.stringify(b));
  });

  it("refuses a body that is not JSON", () => {
    assert.throws(() => parseBakeBody("{nope"), /not valid JSON/);
    assert.throws(() => parseBakeBody(undefined), /not valid JSON/);
  });

  it("turns the request into the CLI's arguments: the site, the world, and the folders the towns live in", () => {
    const args = bakeArgs("/repo", ok);
    const at = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    assert.equal(at("--id"), "0004");
    assert.equal(at("--seed"), "1234");
    assert.equal(at("--population"), "600");
    assert.equal(at("--site"), "2");
    assert.match(at("--world")!, /default\.world\.json$/);
    assert.equal(at("--out"), "/repo/content/settlements");
    assert.equal(at("--scenes"), "/repo/content/scenes");
    assert.ok(args.includes("--scene"));
    assert.match(args[0]!, /settlement[\\/]dist[\\/]src[\\/]cli\.js$/);
  });
});
