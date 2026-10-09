/**
 * The locomotion state machine (animations.json v3): which base clip a
 * character plays from how it moves, and how long the crossfade into it
 * lasts. The client's animator runs `pickLocomotion` every frame; the
 * editor draws and tests the same graph with the same function.
 *
 * States are the idle clips and the gaits per medium (ground, swim, fly);
 * the transitions are implied by the speed thresholds (`from`) and the
 * airborne rule. Gaits are ordered by `from`.
 */
import { checker, isObj, type MediaIssue, type Obj } from "./issue.js";

export interface Gait {
  clip: string;
  /** The clip's own ground speed (m/s): playback is scaled to the actual speed. */
  speed: number;
  /** Speeds from here up use this gait. */
  from: number;
  /** Crossfade into this gait, seconds (default: the graph's `fade`). */
  fade?: number;
}

export interface LocomotionGraph {
  /** Default crossfade between base clips, seconds. */
  fade: number;
  /** Vertical speed that means the feet left the ground, m/s. */
  airborneVy: number;
  /** Seconds above that before the air clip plays. */
  airSeconds: number;
  /** Playback-rate clamp [min, max] when scaling a gait to the actual speed. */
  scale: [number, number];
  idle: { ground: string; swim: string; fly: string; air: string };
  ground: Gait[];
  swim: Gait[];
  fly: Gait[];
}

/** The tuned-by-eye defaults the client always had; content overrides them. */
export const DEFAULT_LOCOMOTION: LocomotionGraph = {
  fade: 0.2,
  airborneVy: 1.5,
  airSeconds: 0.05,
  scale: [0.6, 1.6],
  idle: { ground: "Idle_Loop", swim: "Swim_Idle_Loop", fly: "Swim_Idle_Loop", air: "Jump_Loop" },
  ground: [
    { clip: "Walk_Loop", speed: 1.4, from: 0.3 },
    { clip: "Jog_Fwd_Loop", speed: 3.6, from: 2.2 },
    { clip: "Sprint_Loop", speed: 6.2, from: 4.8 },
  ],
  swim: [{ clip: "Swim_Fwd_Loop", speed: 1.4, from: 0.3 }],
  fly: [{ clip: "Swim_Fwd_Loop", speed: 6, from: 0.5 }],
};

/** How a character is moving. `mode`: 0 ground, 1 swim, 2 fly (LocomotionMode). */
export interface MotionState {
  speed: number;
  vy: number;
  mode: number;
}

export interface LocomotionPick {
  /** The base clip (before any female take is resolved). */
  clip: string;
  timeScale: number;
  /** Seconds to crossfade into it. */
  fade: number;
  /** Which part of the graph chose it. */
  medium: "ground" | "swim" | "fly" | "air";
  /** The gait chosen, null for an idle or air clip. */
  gait: Gait | null;
}

/** The base clip for a motion; `airTime` is how long the character has been airborne (the caller keeps it). */
export function pickLocomotion(g: LocomotionGraph, m: MotionState, airTime = 0): LocomotionPick {
  const clamp = (v: number): number => Math.min(g.scale[1], Math.max(g.scale[0], v));
  const gait = (gaits: Gait[], idle: string, medium: "ground" | "swim" | "fly"): LocomotionPick => {
    const hit = [...gaits].reverse().find((x) => m.speed >= x.from);
    if (!hit) return { clip: idle, timeScale: 1, fade: g.fade, medium, gait: null };
    return { clip: hit.clip, timeScale: clamp(m.speed / hit.speed), fade: hit.fade ?? g.fade, medium, gait: hit };
  };
  if (m.mode === 1) return gait(g.swim, g.idle.swim, "swim");
  if (m.mode === 2) return gait(g.fly, g.idle.fly, "fly");
  if (airTime > g.airSeconds) return { clip: g.idle.air, timeScale: 1, fade: g.fade, medium: "air", gait: null };
  return gait(g.ground, g.idle.ground, "ground");
}

/** Every clip name the graph can play. */
export function locomotionClips(g: LocomotionGraph): string[] {
  return [...new Set([...Object.values(g.idle), ...g.ground.map((x) => x.clip), ...g.swim.map((x) => x.clip), ...g.fly.map((x) => x.clip)])];
}

export function validateLocomotion(doc: unknown, path = ""): MediaIssue[] {
  const c = checker();
  if (!isObj(doc)) return [{ path, message: "locomotion must be an object" }];
  c.num(doc, "fade", path, 0, 2);
  c.num(doc, "airborneVy", path, 0, 100);
  c.num(doc, "airSeconds", path, 0, 5);
  const sc = doc.scale;
  if (!Array.isArray(sc) || sc.length !== 2 || !sc.every((n) => typeof n === "number" && n > 0) || (sc[0] as number) > (sc[1] as number)) {
    c.add(`${path}scale`, "must be [min, max] with 0 < min <= max");
  }
  if (!isObj(doc.idle)) c.add(`${path}idle`, "must be an object");
  else for (const k of ["ground", "swim", "fly", "air"]) c.str(doc.idle, k, `${path}idle.`);
  for (const medium of ["ground", "swim", "fly"] as const) {
    const list = doc[medium];
    if (!Array.isArray(list)) {
      c.add(`${path}${medium}`, "must be a list of gaits");
      continue;
    }
    let prev = -Infinity;
    list.forEach((raw: unknown, i: number) => {
      const p = `${path}${medium}[${i}].`;
      if (!isObj(raw)) return c.add(p.slice(0, -1), "must be an object");
      const o: Obj = raw;
      c.str(o, "clip", p);
      c.num(o, "speed", p, 0.01, 100);
      c.num(o, "from", p, 0, 100);
      if (o.fade !== undefined) c.num(o, "fade", p, 0, 2);
      if (typeof o.from === "number") {
        if (o.from <= prev) c.add(`${p}from`, "gaits must be in increasing order of from");
        prev = o.from;
      }
    });
  }
  return c.issues;
}

/**
 * The graph a manifest carries. v2 is the converter's output (no graph:
 * the defaults); v3 adds `locomotion`. Null for a version we don't know.
 */
export function manifestLocomotion(manifest: { version: number; locomotion?: LocomotionGraph }): LocomotionGraph | null {
  if (manifest.version === 2) return DEFAULT_LOCOMOTION;
  if (manifest.version === 3) return manifest.locomotion ?? DEFAULT_LOCOMOTION;
  return null;
}
