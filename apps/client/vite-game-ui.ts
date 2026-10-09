import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

const HUD = "virtual:hud-layout";
const STRINGS = "virtual:game-strings";

/**
 * Serves the editor-authored UI content to the client: `content/ui/hud.json`
 * as `virtual:hud-layout` and every `content/strings/<lang>.json` as
 * `virtual:game-strings` ({ lang: table }). Edits reload the page in dev.
 */
export function gameUi(contentDir: string): Plugin {
  const hud = join(contentDir, "ui", "hud.json");
  const stringsDir = join(contentDir, "strings");
  const norm = (f: string): string => f.replace(/\\/g, "/");
  return {
    name: "game-ui",
    resolveId: (id) => (id === HUD || id === STRINGS ? `\0${id}` : null),
    load(id) {
      if (id === `\0${HUD}`) {
        this.addWatchFile(hud);
        return `export default ${readFileSync(hud, "utf8")};`;
      }
      if (id === `\0${STRINGS}`) {
        const out: Record<string, unknown> = {};
        for (const f of readdirSync(stringsDir).filter((n) => n.endsWith(".json")).sort()) {
          const file = join(stringsDir, f);
          this.addWatchFile(file);
          out[f.slice(0, -5)] = JSON.parse(readFileSync(file, "utf8"));
        }
        return `export default ${JSON.stringify(out)};`;
      }
      return null;
    },
    configureServer(server) {
      server.watcher.add([hud, stringsDir]);
      server.watcher.on("change", (f) => {
        const n = norm(f);
        if (n === norm(hud) || n.startsWith(`${norm(stringsDir)}/`)) server.ws.send({ type: "full-reload" });
      });
    },
  };
}
