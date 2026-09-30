"use strict";
// Loads the compiled addon (`npm install` builds it via node-gyp). Every
// call is synchronous: these are bake-time operations (dungeon shells,
// footprints), not per-tick work.
let binding;
try {
  // eslint-disable-next-line global-require
  binding = require("./build/Release/geometry.node");
} catch (err) {
  throw new Error(
    "addon-geometry: native binding not found at build/Release/geometry.node. " +
      "Run `npm install` (or `npx node-gyp rebuild -j max` in this package) first. " +
      `Underlying error: ${err.message}`,
  );
}

module.exports = {
  version: () => binding.version(),
  cellsToPolygons: (mask, width, height, opts = {}) => binding.cellsToPolygons(mask, width, height, opts),
  polygonBoolean: (op, a, b) => binding.polygonBoolean(op, a, b),
  polygonOffset: (polygons, delta, opts = {}) => binding.polygonOffset(polygons, delta, opts),
  solid: (tree) => binding.solid(tree),
};
