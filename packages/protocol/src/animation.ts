/**
 * EA21 animation clip ids: the server and client agree on these numbers.
 * The server's AnimationSystem sets clipId; the client's animator maps it
 * back to a clip name in its library. 0 = no clip (locomotion fallback).
 *
 * These are the locomotion and combat clips every character needs. The
 * full library lives in the client's animations.json; this is the
 * gameplay-critical subset the server can request.
 */
export const ClipId = {
  None: 0,
  Idle: 1,
  Walk: 2,
  Jog: 3,
  Sprint: 4,
  Swim: 5,
  Airborne: 6,
  AttackSwordA: 10,
  AttackSwordB: 11,
  AttackSwordC: 12,
  Block: 13,
  Hit: 14,
  Cast: 15,
} as const;

export type ClipId = (typeof ClipId)[keyof typeof ClipId];

/** The clip name in the client's animation library for a clip id. */
export const CLIP_NAMES: Record<number, string> = {
  [ClipId.Idle]: "idle",
  [ClipId.Walk]: "walk",
  [ClipId.Jog]: "jog",
  [ClipId.Sprint]: "sprint",
  [ClipId.Swim]: "swim",
  [ClipId.Airborne]: "airborne",
  [ClipId.AttackSwordA]: "attack-sword-a",
  [ClipId.AttackSwordB]: "attack-sword-b",
  [ClipId.AttackSwordC]: "attack-sword-c",
  [ClipId.Block]: "block",
  [ClipId.Hit]: "hit",
  [ClipId.Cast]: "cast",
};
