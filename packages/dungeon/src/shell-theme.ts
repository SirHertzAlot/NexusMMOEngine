/**
 * A dungeon theme's shell knobs, as a zod schema (strict: an unknown knob is
 * refused, not ignored). Each knob changes the bake:
 *   corridorHeight, roomHeight  ceilings and room heights (metres above floor)
 *   poolDepth                   how far the basins sink
 *   simplifyTolerance           wall-line simplification in the polygon step
 *   ceilingMode                 flat ceilings, or open (no ceiling triangles)
 *   floorStyle, wallStyle       the material names the bake reports per part
 *   cornerMode, cornerSize      square, chamfered or pillared corners, and their size
 *   wallThickness               0: the inside surface only. Above 0: a wall body
 *                               that thick, with its outside faces in the shell
 *
 * Knob left out, with the reason: cellSize (the layout's cell is the unit the
 * mask is painted in; changing it means re-deriving the mask in metres).
 */
import { z } from "zod";
import type { ShellOptions } from "./shell.js";

const style = z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "style names are lowercase words joined by dashes");

export const ShellTheme = z
  .object({
    corridorHeight: z.number().min(2).max(20).default(4),
    roomHeight: z
      .object({ s: z.number().min(2).max(30), m: z.number().min(2).max(30), l: z.number().min(2).max(30) })
      .default({ s: 5, m: 6, l: 8 }),
    poolDepth: z.number().min(0).max(10).default(1.2),
    simplifyTolerance: z.number().min(0).max(2).default(0),
    ceilingMode: z.enum(["flat", "open"]).default("flat"),
    floorStyle: style.default("packed-earth"),
    wallStyle: style.default("rough-stone"),
    cornerMode: z.enum(["square", "chamfered", "pillared"]).default("square"),
    cornerSize: z.number().min(0.1).max(1).default(0.5),
    wallThickness: z.number().min(0).max(2).default(0),
  })
  .strict();
export type ShellTheme = z.infer<typeof ShellTheme>;

/** Parse a theme's shell knobs, throwing with the field path on any error. */
export function parseShellTheme(value: unknown): ShellTheme {
  return ShellTheme.parse(value);
}

/** The shell options a parsed theme drives (the layout's cell is fixed by the bake). */
export function shellOptionsOf(t: ShellTheme): ShellOptions {
  return {
    corridorHeight: t.corridorHeight,
    roomHeight: t.roomHeight,
    poolDepth: t.poolDepth,
    simplifyTolerance: t.simplifyTolerance,
    ceilingMode: t.ceilingMode,
    cornerMode: t.cornerMode,
    cornerSize: t.cornerSize,
    wallThickness: t.wallThickness,
  };
}
