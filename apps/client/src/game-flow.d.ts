/** The game flow document, inlined at build/dev time by vite-game-flow.ts. */
declare module "virtual:game-flow" {
  import type { FlowDoc } from "@mmo-engine/scene";
  const flow: FlowDoc;
  export default flow;
}

/** The audio events and mixer settings, inlined at build/dev time by vite-game-flow.ts (raw JSON; src/audio/sound-logic.ts validates it). */
declare module "virtual:audio-events" {
  const bank: unknown;
  export default bank;
}

/** The animation-side content documents, inlined at build/dev time by vite-game-flow.ts (raw JSON; render/game-content.ts validates them). */
declare module "virtual:combat-moves" {
  const doc: unknown;
  export default doc;
}
declare module "virtual:animation-doc" {
  const doc: unknown;
  export default doc;
}
declare module "virtual:materials-doc" {
  const doc: unknown;
  export default doc;
}
