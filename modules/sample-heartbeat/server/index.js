// Sample server module (roadmap EA9). `createSystems` gets the module context
// and returns one SimSystem per name the manifest declares.
export function createSystems(ctx) {
  let ticks = 0;
  return {
    "sample-heartbeat": {
      name: "sample-heartbeat",
      step() {
        ticks++;
        if (ticks % 600 === 0) ctx.log(`[sample-heartbeat] ${ticks} ticks`);
      },
    },
  };
}
