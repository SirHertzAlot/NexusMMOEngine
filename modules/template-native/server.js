/**
 * Template native module server entry (EA10).
 * Loads the N-API addon and exposes it as the "template-probe" system.
 * Copy this module to start a new native module: update module.json,
 * implement your systems here, and add your C++ sources to binding.gyp.
 */
let addon = null;
try {
  addon = require("./native/addon.node");
} catch (e) {
  // The module is optional: it loads only when the .node file was built.
  // Use the Modules window Build button to compile it.
}

/** @returns {Record<string, import("@mmo-engine/engine-core").SimSystem>} */
function createSystems(ctx) {
  if (!addon) {
    ctx.log("template-native: addon not built — system disabled (Build it from the Modules window).");
    return {};
  }
  ctx.log("template-native: addon loaded.");
  return {
    "template-probe": {
      name: "template-probe",
      // Probe the addon once per tick; a real module would do real work here.
      tick(sim, dt) {
        // The template addon exports a `hello()` returning a string.
        if (typeof addon.hello === "function") {
          const s = addon.hello();
          if (sim.currentTick % 600 === 0) ctx.log(`template-native: addon.hello() = ${s}`);
        }
      },
    },
  };
}

module.exports = { createSystems };
