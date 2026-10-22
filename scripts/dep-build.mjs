#!/usr/bin/env node
/**
 * `node scripts/dep-build.mjs @mmo-engine/x`: build a workspace's dependency
 * before the package's own build, so `npm run build -w <pkg>` works alone.
 * `npm run build` (scripts/build.mjs) builds every workspace once in
 * dependency order and sets MMO_ORDERED_BUILD, so this does nothing there.
 */
import { run } from "./lib/run.mjs";

if (process.env.MMO_ORDERED_BUILD) process.exit(0);
process.exit(run("npm", ["run", "build", `--workspace=${process.argv[2]}`]));
