/**
 * Dev-only: serve <repo>/assets (the licensed art: character parts,
 * textures) at /assets/* to this machine only.
 *
 * The art is git-ignored and never leaves the machine: this plugin runs
 * only under `vite` (dev server), answers loopback requests only, refuses
 * paths that escape the assets folder, and is not part of any build —
 * a production bundle has no /assets route and contains none of the art.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { Plugin } from "vite";

const MIME: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  json: "application/json",
};

const isLoopback = (addr: string | undefined): boolean =>
  addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";

export function localAssets(assetsRoot: string): Plugin {
  const root = resolve(assetsRoot);
  return {
    name: "mmo-local-assets",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/assets/")) return next();
        const deny = (status: number, message: string): void => {
          res.statusCode = status;
          res.setHeader("Content-Type", "text/plain");
          res.end(message);
        };
        if (!isLoopback(req.socket.remoteAddress)) return deny(403, "assets are served to this machine only");
        const file = normalize(join(root, decodeURIComponent(url.pathname.slice("/assets/".length))));
        const rel = relative(root, file);
        if (rel.startsWith("..") || isAbsolute(rel)) return deny(403, "path escapes the assets folder");
        if (!existsSync(file) || !statSync(file).isFile()) return deny(404, "not found");
        res.statusCode = 200;
        res.setHeader("Content-Type", MIME[file.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}
