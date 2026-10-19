"use strict";
// kernel-stages.js — drop-in adapter: the terrain/erosion.ts call shapes
// (h, grid, ...) over the N-API kernel.
//
// Lets the survey swap one operator at a time with no other changes:
//   const { thermalErosion, fluvialErosion, dropletErosion } =
//     useKernel ? require("@mmo-engine/addon-terrain-kernel/kernel-stages")
//               : require("./erosion.js");
//
// The droplet stage takes the world seed (u64 bigint) instead of an rng
// callback: the kernel reproduces mulberry32(seed ^ 0xe20d) bit-identically,
// which is exactly what survey.ts passes today.

const addon = require("./index.js");

function gridOf(grid) {
  return { W: grid.width, D: grid.depth, cell: grid.cell };
}

function thermalErosion(h, grid, talusDeg, passes) {
  const { W, D, cell } = gridOf(grid);
  addon.thermalErode(h, W, D, cell, talusDeg, passes);
}

function fluvialErosion(h, grid, seaLevel, rainShare, passes, strength) {
  const { W, D, cell } = gridOf(grid);
  return addon.fluvialErode(h, W, D, cell, seaLevel, rainShare, passes, strength);
}

function dropletErosion(h, grid, seaLevel, rainShare, droplets, strength, seed) {
  const { W, D, cell } = gridOf(grid);
  // survey.ts calls mulberry32(spec.seed ^ 0xe20d) with a numeric seed;
  // the kernel takes the u64 seed and reproduces that sequence exactly.
  const s = typeof seed === "bigint" ? seed : BigInt(Math.trunc(seed));
  return addon.dropletErode(h, W, D, cell, seaLevel, rainShare, droplets, strength, s);
}

module.exports = { thermalErosion, fluvialErosion, dropletErosion };
