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

/** content/combat/moves.json as `virtual:combat-moves` (EA21). */
export const combatMoves = (file: string): Plugin => jsonModule("virtual:combat-moves", file);

/** content/animation/animations.json (the locomotion graph) as `virtual:animation-doc` (EA21). */
export const animationDoc = (file: string): Plugin => jsonModule("virtual:animation-doc", file);

/** content/materials/materials.json as `virtual:materials-doc` (EA22). */
export const materialsDoc = (file: string): Plugin => jsonModule("virtual:materials-doc", file);

/** content/vfx/budgets.json (particle tier budgets) as `virtual:vfx-budgets` (EG10). */
export const vfxBudgets = (file: string): Plugin => jsonModule("virtual:vfx-budgets", file);

/**
 * A set of VfxEffect JSON files as `virtual:vfx-effects`: one module
 * exporting a record keyed by each effect's own `id` field, so the
 * client's emitter registry resolves wire template hashes
 * (fnv1a32 of the id) against exactly the content the server was
 * authored with. An edit to any file reloads the page in dev.
 */
export function vfxEffects(files: string[]): Plugin {
  const id = "virtual:vfx-effects";
  return {
    name: id,
    resolveId: (req) => (req === id ? `\0${id}` : null),
    load(req) {
      if (req !== `\0${id}`) return null;
      const out: Record<string, unknown> = {};
      for (const file of files) {
        this.addWatchFile(file);
        const doc = JSON.parse(readFileSync(file, "utf8")) as { id: string };
        out[doc.id] = doc;
      }
      return `export default ${JSON.stringify(out)};`;
    },
    configureServer(server) {
      for (const file of files) server.watcher.add(file);
      server.watcher.on("change", (f) => {
        const hit = files.some((file) => f.replace(/\\/g, "/") === file.replace(/\\/g, "/"));
        if (hit) server.ws.send({ type: "full-reload" });
      });
    },
  };
}
