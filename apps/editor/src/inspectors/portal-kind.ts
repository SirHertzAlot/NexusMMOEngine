/** The portal kinds, browser-safe (the dungeon package's PORTAL_KINDS). A test keeps them in step. */
export const PORTAL_KINDS = ["door", "arc", "corridor", "stair"] as const;
export type PortalKind = (typeof PORTAL_KINDS)[number];
