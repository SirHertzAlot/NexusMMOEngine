/**
 * Dev-only: serve the content files the client reads at run time
 * (`content/ui/hud.json`, `content/animation/clips.json`) at /content/*,
 * so an edit saved from the editor shows on the next load.
 *
 * Only the listed folders and only `.json`, so the rest of content/ (quests,
 * rules, dungeons) is not exposed; dev server only, like vite-local-assets.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { Plugin } from "vite";

export const SERVED_CONTENT = ["ui", "animation", "combat"] as const;

export function clientContent(contentRoot: string): Plugin {
  const root = resolve(contentRoot);
  return {
    name: "mmo-client-content",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/content/")) return next();
        const file = normalize(join(root, decodeURIComponent(url.pathname.slice("/content/".length))));
        const rel = relative(root, file);
        const dir = rel.split(/[\\/]/)[0];
        const allowed = !rel.startsWith("..") && !isAbsolute(rel) && file.endsWith(".json") && (SERVED_CONTENT as readonly string[]).includes(dir);
        if (!allowed || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain");
          res.end("not found");
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(readFileSync(file));
      });
    },
  };
}
