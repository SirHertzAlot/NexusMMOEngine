/**
 * Wire shapes the gateway validates before anything else sees them.
 *
 * These are the engine's, not a kit's. A request arrives from a client that
 * may be lying about it, so the gateway checks the shape first and only then
 * asks whichever system answers the port — which means the check cannot live
 * with the system, or a game that replaced that system would have replaced
 * the validation too.
 *
 * `InteractActionSchema` is the example that made the point (`ES5n`). It had
 * been declared in `interact/chests.ts`, which read as if interacting were a
 * chest's business; it is not. One interact request reaches a chest, another a
 * quest giver, another a dungeon entrance, and only the first belongs to
 * `@mmo-engine/kit-economy`. So the schema stayed here when the chests left.
 */

import { z } from "zod";

/** A quest giver's or a dungeon entrance's content id. */
const contentId = z.string().min(1).max(64);

/**
 * An interact request (catalog `0x27`): an entity's wire id, or a quest
 * giver's or dungeon entrance's content id.
 */
export const InteractActionSchema = z.union([
  z.object({ kind: z.literal("interact"), entity: z.string().regex(/^\d{1,20}$/) }).strict(),
  z.object({ kind: z.literal("interact"), npc: contentId }).strict(),
  z.object({ kind: z.literal("interact"), entrance: contentId }).strict(),
]);

/** What the gateway has after a successful parse. */
export type InteractAction = z.infer<typeof InteractActionSchema>;
