// @mmo-engine/addon-codec — C++ fast-path binary delta serialization codec
// Native N-API bindings with fallback resolution.

const path = require("path");
let binding;

try {
  binding = require("./build/Release/codec.node");
} catch (err) {
  try {
    binding = require("./build/Debug/codec.node");
  } catch (errDebug) {
    throw new Error(
      "addon-codec: native binding not found at build/Release/codec.node. " +
      "Run 'npm run install' inside packages/addons/codec to compile with node-gyp. Details: " +
      err.message
    );
  }
}

module.exports = binding;
