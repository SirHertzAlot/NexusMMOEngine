/**
 * EA24 foundation: audio events as data (`content/audio/events.json`).
 *
 * Named events with their bus (master/combat/interface/ambience — U4's
 * sliders), file or weighted variations, volume, and 2D/3D playback.
 * The client plays them; defining an event never touches code.
 */
import { z } from "zod";

export const AudioBus = z.enum(["master", "combat", "interface", "ambience"]);
export type AudioBus = z.infer<typeof AudioBus>;

const Variation = z.object({
  file: z.string().min(1),
  /** Relative pick weight. */
  weight: z.number().min(0).default(1),
});

export const AudioEvent = z.object({
  name: z.string().min(1),
  bus: AudioBus,
  /** Single file, or weighted variations (surface-dependent footsteps). */
  file: z.string().min(1).optional(),
  variations: z.array(Variation).min(1).optional(),
  volume: z.number().min(0).max(1).default(1),
  /** 3D positional (distance-attenuated) vs 2D (UI). */
  positional: z.boolean().default(false),
  /** Audible range in metres (positional only). */
  maxDistance: z.number().min(1).default(40),
  /** Playback-rate range; each play picks one at random (1 = the clip as recorded). */
  pitchRange: z.tuple([z.number().min(0.25).max(4), z.number().min(0.25).max(4)]).refine(([lo, hi]) => lo <= hi, { message: "pitchRange needs min <= max" }).default([1, 1]),
  /** Who survives when a bus is out of voices: the higher priority steals from the lower. */
  priority: z.number().int().min(0).max(10).default(0),
}).refine((e) => e.file !== undefined || e.variations !== undefined, {
  message: "audio event needs a file or variations",
});

export type AudioEvent = z.infer<typeof AudioEvent>;

/** Parse and validate an audio event from JSON (throws on invalid). */
export function loadAudioEvent(json: unknown): AudioEvent {
  return AudioEvent.parse(json);
}

/** Mixer settings of one bus: its level and how many sounds may play on it at once. */
export const BusSettings = z.object({
  gain: z.number().min(0).max(1).default(1),
  maxVoices: z.number().int().min(1).max(64).default(16),
});
export type BusSettings = z.infer<typeof BusSettings>;

/** `content/audio/events.json`: the buses' mixer settings and the events. */
export const AudioBank = z.object({
  buses: z.object({
    master: BusSettings.optional(),
    combat: BusSettings.optional(),
    interface: BusSettings.optional(),
    ambience: BusSettings.optional(),
  }).default({}),
  events: z.array(AudioEvent),
}).superRefine((bank, ctx) => {
  const seen = new Set<string>();
  bank.events.forEach((e, i) => {
    if (seen.has(e.name)) ctx.addIssue({ code: "custom", path: ["events", i, "name"], message: `duplicate event "${e.name}"` });
    seen.add(e.name);
    if (e.variations && e.variations.every((v) => v.weight === 0)) {
      ctx.addIssue({ code: "custom", path: ["events", i, "variations"], message: "every variation has weight 0" });
    }
  });
});
export type AudioBank = z.infer<typeof AudioBank>;

/** Parse and validate a whole audio bank (throws on invalid). */
export function loadAudioBank(json: unknown): AudioBank {
  return AudioBank.parse(json);
}
