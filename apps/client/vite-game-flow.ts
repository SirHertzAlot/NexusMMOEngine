import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

/**
 * Serves a content JSON file as the module `id` (`import x from "virtual:…"`);
 * an edit to the file reloads the page in dev.
 */
export function jsonModule(id: string, file: string): Plugin {
  return {
    name: id,
    resolveId: (req) => (req === id ? `\0${id}` : null),
    load(req) {
      if (req !== `\0${id}`) return null;
      this.addWatchFile(file);
      return `export default ${readFileSync(file, "utf8")};`;
    },
    configureServer(server) {
      server.watcher.add(file);
      server.watcher.on("change", (f) => {
        if (f.replace(/\\/g, "/") === file.replace(/\\/g, "/")) server.ws.send({ type: "full-reload" });
      });
    },
  };
}

/** content/flow/game.flow.json as `virtual:game-flow`. */
export const gameFlow = (file: string): Plugin => jsonModule("virtual:game-flow", file);

/** content/audio/events.json as `virtual:audio-events` (EA24). */
export const audioEvents = (file: string): Plugin => jsonModule("virtual:audio-events", file);
