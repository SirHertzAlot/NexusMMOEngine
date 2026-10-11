/**
 * The character animation library's manifest (animations.json, written by
 * `npm run convert:animations -w @mmo-engine/art` next to the rig): which
 * clips there are, where they came from, and how they move.
 */

export interface AnimationClipInfo {
  name: string;
  /** The source library's id (see AnimationManifest.sources). */
  source: string;
  duration: number;
  loop: boolean;
  /**
   * Horizontal travel over the clip, metres (x, z; +z = the character's
   * forward). Clips play in place: the game moves the character this far.
   */
  travel: [number, number];
}

export interface AnimationSourceInfo {
  id: string;
  title: string;
  author: string;
  license: string;
  url: string;
  /** The GLB holding the source's clips, relative to the manifest. */
  file: string;
  /** Raw reference takes (long mocap): not loaded by the game. */
  reference?: boolean;
}

export interface AnimationManifest {
  /** 2: the converter's; 3 adds `locomotion` (content/animation/animations.json). */
  version: 2 | 3;
  sources: AnimationSourceInfo[];
  clips: AnimationClipInfo[];
  /** v3 only: the base-clip state machine (art `pickLocomotion`). */
  locomotion?: import("../media/locomotion.js").LocomotionGraph;
}
