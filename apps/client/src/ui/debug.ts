/**
 * The developer panels, as the editor's play-mode debugger hosts them
 * (ROADMAP E5): the same dockable HUD, performance graphs and admin
 * console the developer client shows, not copies. The editor resolves
 * `@mmo-engine/client/debug` here (its Vite alias and tsconfig paths);
 * nothing in the client imports this file.
 */

export { DevHud, type DevPanelSpec, type Viewport } from "./dev-panels.js";
export type { DevLayout, PanelLayout } from "./dev-layout.js";
export { PerfHud } from "./perf-hud.js";
export { AdminConsole } from "./admin-console.js";
export { ACTIONS, actionLabel, FIXED_MOUSE, fixedMouseLabel, mouseButtonLabel, prettyCode } from "../input/bindings.js";
// The editor loads the string tables into the same `t()` so the legend above reads in words.
export { initI18n } from "../i18n.js";
