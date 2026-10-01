"use strict";
// Callgrind marks (src/probe.cc). No-ops outside valgrind.
let binding;
try {
  // eslint-disable-next-line global-require
  binding = require("./build/Release/perf_probe.node");
} catch (err) {
  throw new Error(`addon-perf-probe: native binding not found (run \`npm install\`): ${err.message}`);
}
module.exports = {
  /** True inside valgrind. */
  running: () => binding.running(),
  /** Zero the counters and start collecting. */
  begin: () => binding.begin(),
  /** Stop collecting and write a callgrind dump named `name`. */
  end: (name) => binding.end(String(name)),
};
