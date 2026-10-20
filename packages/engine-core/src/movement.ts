/**
 * Movement tuning (content/rules/movement.json, MovementSchema in
 * @mmo-engine/rules): the engine's defaults, which a world uses until the
 * server hands it the rules (`SimWorld.movement`, replaced on a rules
 * reload). Systems read the world's copy each step, so a reload applies on
 * the next tick.
 */

import { MovementSchema, type MovementRules } from "@mmo-engine/rules";

export type { MovementRules };

/** The engine defaults (an absent movement.json). */
export const DEFAULT_MOVEMENT: Readonly<MovementRules> = Object.freeze(MovementSchema.parse({}));
