/**
 * Weather override (roadmap A4): the server's forced sky replaces the
 * deterministic tick/biome hash; auto keeps it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { weatherAt, type WeatherRules } from "../src/render/fx/weather.js";

const RULES: WeatherRules = {
  biomes: { rainforest: { kind: "rain", chance: 1 } },
  spellMinutes: 10,
};

describe("weatherAt override", () => {
  it("auto follows the tick/biome hash", () => {
    assert.deepEqual(weatherAt(RULES, "rainforest", 0, 30, "auto"), { kind: "rain", intensity: 1 });
  });

  it("a forced kind falls at full intensity anywhere", () => {
    assert.deepEqual(weatherAt(RULES, "plains", 0, 30, "snow"), { kind: "snow", intensity: 1 });
    assert.deepEqual(weatherAt(RULES, null, 0, 30, "ash"), { kind: "ash", intensity: 1 });
  });

  it("forced clear falls nothing even where it would rain", () => {
    assert.deepEqual(weatherAt(RULES, "rainforest", 0, 30, "clear"), { kind: null, intensity: 0 });
  });
});
