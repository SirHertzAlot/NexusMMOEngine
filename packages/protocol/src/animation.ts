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
  // Locomotion
  Idle: 1,
  Walk: 2,
  Jog: 3,
  Sprint: 4,
  Swim: 5,
  Airborne: 6,
  Trot: 7,
  Gallop: 8,
  Fly: 9,
  // Humanoid combat
  AttackSwordA: 10,
  AttackSwordB: 11,
  AttackSwordC: 12,
  Block: 13,
  Hit: 14,
  Cast: 15,
  Roll: 16,
  ShieldBash: 17,
  // Creature / Beast / Monster moves
  Bite: 20,
  Claw: 21,
  Pounce: 22,
  Roar: 23,
  Breath: 24,
  TailWhip: 25,
  Stomp: 26,
  WingBuffet: 27,
  Sting: 28,
  Cleave: 29,
  // Creature behavioral states
  Graze: 40,
  Sleep: 41,
  Threaten: 42,
  DeathFall: 43,
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
  [ClipId.Trot]: "trot",
  [ClipId.Gallop]: "gallop",
  [ClipId.Fly]: "fly",
  [ClipId.AttackSwordA]: "attack-sword-a",
  [ClipId.AttackSwordB]: "attack-sword-b",
  [ClipId.AttackSwordC]: "attack-sword-c",
  [ClipId.Block]: "block",
  [ClipId.Hit]: "hit",
  [ClipId.Cast]: "cast",
  [ClipId.Roll]: "roll",
  [ClipId.ShieldBash]: "shield-bash",
  [ClipId.Bite]: "bite",
  [ClipId.Claw]: "claw",
  [ClipId.Pounce]: "pounce",
  [ClipId.Roar]: "roar",
  [ClipId.Breath]: "breath",
  [ClipId.TailWhip]: "tail-whip",
  [ClipId.Stomp]: "stomp",
  [ClipId.WingBuffet]: "wing-buffet",
  [ClipId.Sting]: "sting",
  [ClipId.Cleave]: "cleave",
  [ClipId.Graze]: "graze",
  [ClipId.Sleep]: "sleep",
  [ClipId.Threaten]: "threaten",
  [ClipId.DeathFall]: "death-fall",
};
