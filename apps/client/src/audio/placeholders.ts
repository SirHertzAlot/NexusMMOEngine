/**
 * Placeholder clips (EA24): there are no licensed recordings in the repo,
 * so the event named by a file ("sword-hit.ogg", "step-grass.ogg") is
 * synthesized from oscillators and noise, picked by a keyword in the file
 * name. Variations of one event (grass / stone / wood steps) therefore sound
 * different. When real samples land, they replace this behind the same
 * `file` names and nothing else changes.
 */

import { noise, tone } from "./cues.js";

/** The recipe for a file: [keyword in the name, plays the clip]. First match wins. */
const RECIPES: [string, (ctx: BaseAudioContext, out: AudioNode, r: number) => number][] = [
  ["grass", (c, o, r) => (noise(c, o, "bandpass", 700 * r, 0.5, 0.11), 0.13)],
  ["stone", (c, o, r) => (noise(c, o, "highpass", 1800 * r, 0.45, 0.07), tone(c, o, 300 * r, "square", 0.08, 0.05), 0.1)],
  ["wood", (c, o, r) => (tone(c, o, 190 * r, "triangle", 0.5, 0.1, 0, 120 * r), noise(c, o, "bandpass", 500 * r, 0.25, 0.06), 0.13)],
  ["hit", (c, o, r) => (tone(c, o, 140 * r, "sine", 0.7, 0.22, 0, 55 * r), noise(c, o, "lowpass", 900 * r, 0.45, 0.14), 0.25)],
  ["block", (c, o, r) => (tone(c, o, 1240 * r, "triangle", 0.22, 0.4), tone(c, o, 1710 * r, "triangle", 0.15, 0.3), noise(c, o, "highpass", 3000, 0.2, 0.06), 0.45)],
  ["dodge", (c, o, r) => (noise(c, o, "bandpass", 500 * r, 1.2, 0.25, 2400 * r), 0.3)],
  ["pickup", (c, o, r) => (tone(c, o, 520 * r, "triangle", 0.25, 0.12), tone(c, o, 780 * r, "triangle", 0.25, 0.12, 0.07), tone(c, o, 1040 * r, "sine", 0.2, 0.3, 0.14), 0.5)],
  ["click", (c, o, r) => (tone(c, o, 1800 * r, "square", 0.08, 0.03), 0.06)],
  ["whisper", (c, o, r) => (tone(c, o, 880 * r, "sine", 0.25, 0.35), tone(c, o, 1318.5 * r, "sine", 0.22, 0.5, 0.12), 0.65)],
  ["notice", (c, o, r) => (tone(c, o, 660 * r, "triangle", 0.2, 0.25), 0.3)],
];

/** A stable number from a file name, so an unknown name always sounds the same. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Schedules the placeholder for `file` into `out` at playback rate `pitch`. Returns its length in seconds. */
export function playPlaceholder(ctx: BaseAudioContext, out: AudioNode, file: string, pitch: number): number {
  const name = file.toLowerCase();
  const recipe = RECIPES.find(([key]) => name.includes(key));
  if (recipe) return recipe[1](ctx, out, pitch);
  // Unknown clip: a short tone whose note comes from the name.
  tone(ctx, out, (220 + (hash(name) % 12) * 55) * pitch, "triangle", 0.3, 0.25);
  return 0.3;
}
