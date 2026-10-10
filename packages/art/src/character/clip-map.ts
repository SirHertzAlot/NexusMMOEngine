/**
 * EA21 clip map: which clip in the animation library a server clip id
 * plays, and how (loops, crossfade). The server sends a ClipId (protocol
 * animation.ts); `content/animation/clips.json` says what that means for
 * the client, so retuning a gait or swapping a take is a data edit, not a
 * code change. The client and the editor's Animation panel share this
 * module; the dev host validates with it before it writes the file.
 */

import { ClipId } from "@mmo-engine/protocol";

export interface ClipMapEntry {
  /** The server's clip id (a protocol ClipId, or any id a game adds). */
  id: number;
  /** A label for the editor (the clip id's role: "walk", "attack sword A"). */
  name: string;
  /** The clip's name in the animation library (animations.json). */
  clip: string;
  /** Repeats until the server picks another clip (a gait, a held guard). */
  loop: boolean;
  /** Seconds to crossfade into this clip (and out of it, for an action). */
  fade: number;
}

export interface ClipMap {
  version: 1;
  clips: ClipMapEntry[];
}

export interface ClipMapIssue {
  severity: "error" | "warn";
  /** Index into `clips`, or null for the document. */
  row: number | null;
  /** The field the issue is about. */
  field: keyof ClipMapEntry | "version" | "clips" | null;
  message: string;
}

export const MAX_CLIP_ID = 0xffff;
export const MAX_FADE = 2;

/** The map the game ships with: the gaits and combat clips the server asks for today. */
export const DEFAULT_CLIP_MAP: ClipMap = {
  version: 1,
  clips: [
    { id: ClipId.Idle, name: "idle", clip: "Idle_Loop", loop: true, fade: 0.2 },
    { id: ClipId.Walk, name: "walk", clip: "Walk_Loop", loop: true, fade: 0.2 },
    { id: ClipId.Jog, name: "jog", clip: "Jog_Fwd_Loop", loop: true, fade: 0.2 },
    { id: ClipId.Sprint, name: "sprint", clip: "Sprint_Loop", loop: true, fade: 0.2 },
    { id: ClipId.Swim, name: "swim", clip: "Swim_Fwd_Loop", loop: true, fade: 0.2 },
    { id: ClipId.Airborne, name: "airborne", clip: "Jump_Loop", loop: true, fade: 0.15 },
    { id: ClipId.AttackSwordA, name: "attack sword A", clip: "Sword_Regular_A", loop: false, fade: 0.08 },
    { id: ClipId.AttackSwordB, name: "attack sword B", clip: "Sword_Regular_B", loop: false, fade: 0.08 },
    { id: ClipId.AttackSwordC, name: "attack sword C", clip: "Sword_Regular_C", loop: false, fade: 0.08 },
    { id: ClipId.Block, name: "block", clip: "Idle_Shield_Loop", loop: true, fade: 0.12 },
    { id: ClipId.Hit, name: "hit", clip: "Hit_Reaction", loop: false, fade: 0.05 },
    { id: ClipId.Cast, name: "cast", clip: "Cast_Spell", loop: false, fade: 0.1 },
  ],
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Check a clip map: every problem, none thrown. Errors block a save;
 * warnings do not (a clip the library lacks plays nothing, and the
 * character falls back to locomotion). `library` is the clip names the
 * animation library has, when known.
 */
export function checkClipMap(map: unknown, library?: Iterable<string>): ClipMapIssue[] {
  const issues: ClipMapIssue[] = [];
  if (!isObject(map)) return [{ severity: "error", row: null, field: null, message: "the clip map must be an object" }];
  if (map.version !== 1) issues.push({ severity: "error", row: null, field: "version", message: `version ${String(map.version)} is not supported (expected 1)` });
  if (!Array.isArray(map.clips)) {
    issues.push({ severity: "error", row: null, field: "clips", message: "clips must be a list" });
    return issues;
  }
  const names = library ? new Set(library) : null;
  const seen = new Map<number, number>();
  map.clips.forEach((raw, row) => {
    const err = (field: keyof ClipMapEntry, message: string): void => void issues.push({ severity: "error", row, field, message });
    if (!isObject(raw)) return err("id", "each clip must be an object");
    const { id, name, clip, loop, fade } = raw;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > MAX_CLIP_ID) err("id", `id must be a whole number from 1 to ${MAX_CLIP_ID} (0 means no clip)`);
    else if (seen.has(id)) err("id", `id ${id} is already used by row ${seen.get(id)! + 1}`);
    else seen.set(id, row);
    if (typeof name !== "string" || name.trim() === "") err("name", "name is empty");
    if (typeof clip !== "string" || clip.trim() === "") err("clip", "clip is empty");
    else if (names && !names.has(clip)) issues.push({ severity: "warn", row, field: "clip", message: `"${clip}" is not in the animation library` });
    if (typeof loop !== "boolean") err("loop", "loop must be true or false");
    if (typeof fade !== "number" || !Number.isFinite(fade) || fade < 0 || fade > MAX_FADE) err("fade", `fade must be from 0 to ${MAX_FADE} seconds`);
  });
  return issues;
}

/** A clip map from parsed JSON; throws with the first error when it is not one. */
export function parseClipMap(json: unknown): ClipMap {
  const first = checkClipMap(json).find((i) => i.severity === "error");
  if (first) throw new Error(`clip map: ${first.row === null ? "" : `row ${first.row + 1}: `}${first.message}`);
  return json as ClipMap;
}

/** The map by clip id, for the per-frame lookup. */
export function indexClipMap(map: ClipMap): ReadonlyMap<number, ClipMapEntry> {
  return new Map(map.clips.map((c) => [c.id, c]));
}

/** The smallest id above every id in use (a new row's id). */
export function nextClipId(map: ClipMap): number {
  return Math.min(MAX_CLIP_ID, map.clips.reduce((m, c) => Math.max(m, c.id), 0) + 1);
}
