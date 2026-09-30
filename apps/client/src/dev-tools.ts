/**
 * Whether the client runs with its developer panels: `npm run dev` (the
 * client's `dev:tools` script, Vite mode "devtools"). `npm run client` is
 * the player's client and never shows them. The panels move to the
 * editor's play mode once it embeds the game view (docs/ROADMAP.md E4, E5).
 */
export const DEV_TOOLS = (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE === "devtools";
