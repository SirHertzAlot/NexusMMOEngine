"use strict";
// Loads the compiled addon. `npm install` builds it via `node-gyp rebuild`.
let binding;
try {
  // eslint-disable-next-line global-require
  binding = require("./build/Release/integrate.node");
} catch (err) {
  throw new Error(
    "addon-integrate: native binding not found at build/Release/integrate.node. " +
      "Run `npm install` (or `npx node-gyp rebuild` in this package) first. " +
      `Underlying error: ${err.message}`,
  );
}

module.exports = binding;
