import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const ID = "virtual:game-content";

/** The media documents (see MEDIA_DOCS in @mmo-engine/art), by name, under content/. */
export const CONTENT_FILES = {
  combat: "combat/moves.json",
  animation: "animation/animations.json",
  vfx: "vfx/effects.json",
  tiers: "vfx/tiers.json",
  materials: "materials/materials.json",
  audio: "audio/events.json",
} as const;

/** Serves the media documents of `contentDir` as the `virtual:game-content` module; edits reload the page in dev. */
export function gameContent(contentDir: string): Plugin {
  const files = Object.entries(CONTENT_FILES).map(([name, rel]) => [name, resolve(contentDir, rel)] as const);
  const norm = (f: string): string => f.replace(/\\/g, "/");
  return {
    name: "game-content",
    resolveId: (id) => (id === ID ? `\0${ID}` : null),
    load(id) {
      if (id !== `\0${ID}`) return null;
      const parts: string[] = [];
      for (const [name, file] of files) {
        this.addWatchFile(file);
        if (existsSync(file)) parts.push(`${JSON.stringify(name)}: ${readFileSync(file, "utf8")}`);
      }
      return `export default {${parts.join(",")}};`;
    },
    configureServer(server) {
      for (const [, file] of files) server.watcher.add(file);
      const mine = new Set(files.map(([, f]) => norm(f)));
      server.watcher.on("change", (f) => {
        if (mine.has(norm(f))) server.ws.send({ type: "full-reload" });
      });
    },
  };
}
