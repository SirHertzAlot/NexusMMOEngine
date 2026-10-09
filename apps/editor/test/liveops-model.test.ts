/** Live ops helpers: console line parsing, replies of help/weather/time, uptime. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatUptime, parseConsoleLine, parseHelp, parseTimeOfDay, parseWeather, timeArgs } from "../src/liveops-model.js";

describe("parseConsoleLine", () => {
  it("a bare command has no args", () => assert.deepEqual(parseConsoleLine("  heal "), { command: "heal" }));
  it("key=value pairs become typed args", () => {
    assert.deepEqual(parseConsoleLine("teleport x=10 z=-4.5"), { command: "teleport", args: { x: 10, z: -4.5 } });
    assert.deepEqual(parseConsoleLine("god on=true entity=me"), { command: "god", args: { on: true, entity: "me" } });
  });
  it("a JSON object is passed through", () => {
    assert.deepEqual(parseConsoleLine('set {"entity":"me","value":3}'), { command: "set", args: { entity: "me", value: 3 } });
  });
  it("refuses what cannot be a command", () => {
    for (const bad of ["", "Heal", "heal x", "set {nope", "set [1]"]) assert.ok("error" in (parseConsoleLine(bad) as object), bad);
  });
});

describe("server replies", () => {
  it("reads the command list, the weather, the time", () => {
    assert.deepEqual(parseHelp("commands: help, whoami, stats"), ["help", "whoami", "stats"]);
    assert.deepEqual(parseHelp("nope"), []);
    assert.equal(parseWeather("weather: rain (forced)"), "rain");
    assert.equal(parseWeather("weather: auto (following the sky)"), "auto");
    assert.equal(parseWeather("weather: hail"), null);
    assert.deepEqual(parseTimeOfDay("07:30 (a day lasts 2400 s)"), { hour: 7, minute: 30 });
    assert.equal(parseTimeOfDay("no day cycle"), null);
  });
  it("checks time arguments", () => {
    assert.deepEqual(timeArgs(6, 15), { hour: 6, minute: 15 });
    assert.ok("error" in timeArgs(24));
    assert.ok("error" in timeArgs(5, 60));
    assert.ok("error" in timeArgs(1.5));
  });
  it("formats uptime", () => {
    assert.equal(formatUptime(12_000), "12 s");
    assert.equal(formatUptime(249_000), "4 m 09 s");
    assert.equal(formatUptime(3_720_000), "1 h 02 m");
  });
});
