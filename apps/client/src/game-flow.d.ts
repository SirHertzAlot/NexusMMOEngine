/** The game flow document, inlined at build/dev time by vite-game-flow.ts. */
declare module "virtual:game-flow" {
  import type { FlowDoc } from "@mmo-engine/scene";
  const flow: FlowDoc;
  export default flow;
}

/** The media documents under content/ (combat, animation, vfx, tiers, materials, audio), inlined by vite-game-content.ts. */
declare module "virtual:game-content" {
  import type { GameContent } from "@mmo-engine/art/browser";
  const content: GameContent;
  export default content;
}
