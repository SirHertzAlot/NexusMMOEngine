/**
 * Sound cues (U4 audio): the names of the audio events the interface and
 * combat feedback play, and the bus each rides. The sounds themselves are
 * data: content/audio/events.json (generated tones until recorded samples
 * replace them), played by AudioEngine through @mmo-engine/art's mixer.
 */

import type { AudioBus } from "./volumes.js";

export type Cue = "whisper" | "notice" | "click" | "hit" | "block" | "dodge";

export const CUE_BUS: Record<Cue, AudioBus> = {
  whisper: "interface",
  notice: "interface",
  click: "interface",
  hit: "effects",
  block: "effects",
  dodge: "effects",
};
