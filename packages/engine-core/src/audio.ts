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
}).refine((e) => e.file !== undefined || e.variations !== undefined, {
  message: "audio event needs a file or variations",
});

export type AudioEvent = z.infer<typeof AudioEvent>;

/** Parse and validate an audio event from JSON (throws on invalid). */
export function loadAudioEvent(json: unknown): AudioEvent {
  return AudioEvent.parse(json);
}
