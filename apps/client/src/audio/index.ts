/**
 * The audio engine and its pure logic, as the editor's Audio panel uses them
 * (EA24): the panel auditions events with the same engine the game plays
 * them with. The editor resolves `@mmo-engine/client/audio` here (its Vite
 * alias and tsconfig paths); nothing in the client imports this file.
 */

export { AudioEngine } from "./engine.js";
export { DEFAULT_VOLUMES } from "./volumes.js";
export * from "./sound-logic.js";
