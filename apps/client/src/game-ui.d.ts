/** The editor-authored UI content, inlined at build/dev time by vite-game-ui.ts. */
declare module "virtual:hud-layout" {
  import type { HudDoc } from "@mmo-engine/scene";
  const hud: HudDoc;
  export default hud;
}
declare module "virtual:game-strings" {
  import type { StringsBundle } from "@mmo-engine/scene";
  const strings: Record<string, StringsBundle>;
  export default strings;
}
