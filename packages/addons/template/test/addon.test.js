"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const addon = require("../index.js");

test("native toolchain: addon loads and hello() answers", () => {
  assert.equal(typeof addon.hello, "function");
  assert.equal(addon.hello(), "mmo-engine native toolchain OK");
});
