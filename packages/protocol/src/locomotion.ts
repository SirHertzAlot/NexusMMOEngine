/**
 * Locomotion — how an entity moves, shared by server and clients.
 *
 * The server's CharacterSystem owns the mode; clients read it (the
 * Locomotion component in snapshots/deltas) to animate and show breath,
 * and ask for flight with an intent button. Values are wire contract:
 * never renumber.
 */

/** Locomotion.mode. */
export const LocomotionMode = {
  Ground: 0,
  Swim: 1,
  Fly: 2,
} as const;
export type LocomotionMode = (typeof LocomotionMode)[keyof typeof LocomotionMode];

/** Locomotion.abilities bits. */
export const Ability = {
  Swim: 0x01,
  Fly: 0x02,
} as const;

/** PlayerIntent.buttons bits. */
export const IntentButton = {
  /** Take off / land (edge-triggered: press, not hold). Needs Ability.Fly. */
  ToggleFlight: 0x01,
  /** Attack (press; a press in a hit's chain window continues the combo). */
  Attack: 0x02,
  /** Guard (held). */
  Block: 0x04,
  /** Dodge roll (press). */
  Dodge: 0x08,
} as const;
