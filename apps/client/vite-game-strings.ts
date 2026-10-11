import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

const ID = "virtual:game-strings";
const RESOLVED = `\0${ID}`;

/** Serves content/strings/<lang>.json as the `virtual:game-strings` module ({ en: {...}, de: {...} }); an edit, a new language or a removed one reloads the page in dev. */
export function gameStrings(dir: string): Plugin {
  const tables = (): string => {
    const out: Record<string, unknown> = {};
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) out[f.slice(0, -5)] = JSON.parse(readFileSync(join(dir, f), "utf8"));
    return `export default ${JSON.stringify(out)};`;
  };
  const inDir = (f: string): boolean => f.replace(/\\/g, "/").startsWith(dir.replace(/\\/g, "/") + "/") && f.endsWith(".json");
  return {
    name: "game-strings",
    resolveId: (id) => (id === ID ? RESOLVED : null),
    load(id) {
      return id === RESOLVED ? tables() : null;
    },
    configureServer(server) {
      server.watcher.add(dir);
      const changed = (f: string): void => {
        if (!inDir(f)) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: "full-reload" });
      };
      for (const ev of ["add", "change", "unlink"] as const) server.watcher.on(ev, changed);
    },
  };
}
