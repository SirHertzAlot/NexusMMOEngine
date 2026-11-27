/**
 * props module — server entry (roadmap ES5l).
 *
 * The world's chests and doors (IX1) and the props that break in it (IX4,
 * IX5): barrels, crates, urns, and the parts a building comes apart into.
 *
 * `server.ts` built both of these itself, which made it the last place in
 * the engine's entry point that named an economy system. It asks for the
 * `chests` and `breaks` services now and goes without when this module is
 * off: a scene's chests and breakables are not registered, so nothing opens
 * and nothing breaks.
 *
 * What stays with the host, and is handed down through `ctx.config.props`:
 *
 * - `places.db` (`SqlitePlacesStore`), because a break or an opened chest
 *   rides the range snapshot and recall seeds it back, which is the
 *   engine's business with the world server rather than a game's.
 * - the respawn pool, shared with everything else that comes back.
 * - the loot a table rolls, which is the items module's.
 * - who struck last, which is the combat kit's.
 * - the materials a repair spends, which is the gathering module's pouch.
 * - `onBreak`, because a broken part is what topples a building and
 *   `CollapseSystem` is the host's own (`core` declares it).
 *
 * The tick order is the one the open world has always run — chests, then
 * breaks, then collapse — held by `before: ["collapse"]` on both. Those
 * edges name a `core` system on purpose: an edge to another optional
 * module's system would make this module refuse to boot without it.
 */
import { BreakSystem, breakDefsOf, ChestSystem } from "../../packages/engine-core/dist/src/interact/index.js";

export function createSystems(ctx) {
  const cfg = ctx.config?.props ?? {};
  const need = (name) => {
    const v = cfg[name];
    if (v === undefined) throw new Error(`props: the host must pass ctx.config.props.${name}`);
    return v;
  };
  const store = need("placesStore");
  const pool = cfg.pool;

  // Chests are entities opened with E (interact, 0x27). What a chest costs to
  // open and what it drops are the host's: it owns the items.
  const chests = new ChestSystem({
    has: (holder, base) => cfg.has(holder, base),
    take: (holder, base) => cfg.take(holder, base),
    drop: (sim, table, x, z, owner) => cfg.drop(sim, table, x, z, owner),
    store,
    pool,
  });

  // A scene node with a Breakable component. Combat already hurts anything
  // with Health, so at zero it is this system's turn. The table starts empty
  // and the host registers what a scene places.
  const breaks = new BreakSystem(breakDefsOf(), {
    store,
    pool,
    materials: cfg.materials,
    killerOf: (e) => cfg.killerOf(e),
    onBreak: (sim, ev) => cfg.onBreak(sim, ev),
  });

  return { chests, breaks };
}
