"use strict";
// Loads the compiled addon. `npm install` builds it via `node-gyp rebuild`.
let binding;
try {
  // eslint-disable-next-line global-require
  binding = require("./build/Release/fanout.node");
} catch (err) {
  throw new Error(
    "addon-fanout: native binding not found at build/Release/fanout.node. " +
      "Run `npm install` (or `npx node-gyp rebuild` in this package) first. " +
      `Underlying error: ${err.message}`,
  );
}

module.exports = binding;
