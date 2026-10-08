import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

const ID = "virtual:game-flow";

/** Serves content/flow/game.flow.json as the `virtual:game-flow` module; edits reload the page in dev. */
export function gameFlow(file: string): Plugin {
  return {
    name: "game-flow",
    resolveId: (id) => (id === ID ? `\0${ID}` : null),
    load(id) {
      if (id !== `\0${ID}`) return null;
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
