/**
 * Serve @pmndrs/detect-gpu's benchmark data from this app at
 * /gpu-benchmarks/* (dev server) and emit it into builds, so GPU
 * detection never calls out to a CDN. The data ships in the package.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

function benchmarksDir(): string {
  // The package exports only its ESM entry; the data sits beside it.
  const entry = fileURLToPath(import.meta.resolve("@pmndrs/detect-gpu"));
  return join(dirname(entry), "benchmarks");
}

export function gpuBenchmarks(route = "/gpu-benchmarks"): Plugin {
  const dir = benchmarksDir();
  const files = readdirSync(dir).filter((f) => /^[dm]-[a-z0-9-]+\.json$/.test(f));
  return {
    name: "mmo-gpu-benchmarks",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        if (!path.startsWith(`${route}/`)) return next();
        const name = path.slice(route.length + 1);
        if (!files.includes(name)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(readFileSync(join(dir, name)));
      });
    },
    generateBundle() {
      for (const f of files) this.emitFile({ type: "asset", fileName: `${route.slice(1)}/${f}`, source: readFileSync(join(dir, f)) });
    },
  };
}
