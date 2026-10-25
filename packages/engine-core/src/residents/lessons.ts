/**
 * Lessons (RS5 learn): a master of a profession teaches a skill for gold, once a game day per pupil.
 * A lesson adds bonus skill points on top of use-based gain, by an S curve of the pupil's level: small
 * at the start, fastest a third of the way up, then harder toward the top (a lesson at 90 is worth a
 * fraction of one at 30). The curve is `peak * (27/4) * m * (1 - m)^2` for m = level / max, never below
 * `floor` of the peak while the pupil has room to grow; a grand master's lessons are worth `grandFactor` times as much.
 */

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const LessonsSchema = z.object({
  version: z.literal(1),
  /** Skill points a lesson gives at the curve's peak. */
  peak: z.number().positive(),
  /** Least share of the peak a pupil below the top still gets. */
  floor: z.number().min(0).max(1).default(0.15),
  grandFactor: z.number().min(1).default(1.5),
  /** Gold a lesson costs, by the pupil's level share: `cost` at 0, `cost * (1 + level/max * costSlope)` at the top. */
  cost: z.number().int().min(0),
  costSlope: z.number().min(0).default(4),
  /** The skill each profession teaches. */
  professions: z.record(z.string(), z.string()),
});
export type Lessons = z.infer<typeof LessonsSchema>;

export function loadLessons(file: string): Lessons | null {
  if (!existsSync(file)) return null;
  const parsed = LessonsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** The points a lesson adds to a skill at `level` (0..max). */
export function lessonPoints(l: Lessons, level: number, max: number, grand: boolean): number {
  const m = Math.min(1, Math.max(0, level / max));
  if (m >= 1) return 0;
  const curve = (27 / 4) * m * (1 - m) * (1 - m);
  return l.peak * Math.max(l.floor, curve) * (grand ? l.grandFactor : 1);
}

/** What a lesson costs a pupil at `level`. */
export function lessonCost(l: Lessons, level: number, max: number): number {
  return Math.round(l.cost * (1 + Math.min(1, Math.max(0, level / max)) * l.costSlope));
}
