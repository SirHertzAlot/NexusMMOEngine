// Sample server module (roadmap EA9). `createSystems` gets the module context
// and returns one SimSystem per name the manifest declares.
//
// It also shows where a module's settings come from (ES4): `everyTicks` is
// this module's own key, set in a game's `game.json` under
// `modules["sample-heartbeat"]`, and the default here applies when nothing
// sets it. Nothing in the engine lists the key — a module you write reads its
// own settings the same way.
export function createSystems(ctx) {
  const everyTicks = Number(ctx.config?.["sample-heartbeat"]?.everyTicks ?? 600);
  let ticks = 0;
  ctx.log(`[sample-heartbeat] every ${everyTicks} ticks`);
  return {
    "sample-heartbeat": {
      name: "sample-heartbeat",
      step() {
        ticks++;
        if (ticks % everyTicks === 0) ctx.log(`[sample-heartbeat] ${ticks} ticks`);
      },
    },
  };
}
