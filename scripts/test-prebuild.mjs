#!/usr/bin/env node
/**
 * Runs once before the workspace tests (`npm test`): builds every workspace
 * with a build script once, in dependency order, so the workspace test scripts
 * can run with MMO_ORDERED_BUILD set (scripts/dep-build.mjs becomes a no-op).
 * Without this, each test script rebuilds its whole dependency chain: 194 build
 * runs for 30 workspaces, about 6 minutes in dungeon alone.
 */
import { buildOrder } from "./lib/build-order.mjs";
import { npm } from "./lib/run.mjs";

for (const name of buildOrder()) {
  npm("prebuild", ["run", "build", `--workspace=${name}`], { env: { MMO_ORDERED_BUILD: "1" }, hint: `${name} failed to build; the error is above` });
}
