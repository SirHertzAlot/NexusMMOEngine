"use strict";
// Loads the compiled addon (`npm install` builds it via node-gyp) and
// wraps its callback cook in a promise. pcg-core keeps process-global
// state (cook cache, cancel flag), so cooks run one at a time, in order.
let binding;
try {
  // eslint-disable-next-line global-require
  binding = require("./build/Release/picg.node");
} catch (err) {
  throw new Error(
    "addon-picg: native binding not found at build/Release/picg.node. " +
      "Run `npm install` (or `npx node-gyp rebuild -j max` in this package) first. " +
      `Underlying error: ${err.message}`,
  );
}

let queue = Promise.resolve();

/** Cook a flattened `.pcg` graph (JSON string or object) with a seed. */
function cook(graph, seed = 0) {
  const json = typeof graph === "string" ? graph : JSON.stringify(graph);
  const run = () =>
    new Promise((resolve, reject) => {
      binding.cook(json, seed | 0, (err, result) => (err ? reject(err) : resolve(result)));
    });
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

/** Null when the graph is valid, else pcg-core's message. */
function validate(graph) {
  return binding.validate(typeof graph === "string" ? graph : JSON.stringify(graph));
}

module.exports = {
  version: () => binding.version(),
  validate,
  cook,
  clearCache: () => binding.clearCache(),
  /** meshoptimizer over PCGM bytes: welded, cache/overdraw-ordered mesh plus a LOD chain (sync). */
  optimizeMesh: (pcgm, opts = {}) => binding.optimizeMesh(pcgm, opts),
};
