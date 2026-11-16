/**
 * Collision for the server's physics, from the same shell the client renders:
 * the shell's floor, wall and ceiling triangles, and the outside of the wall
 * body when the walls have a thickness (basins are liquid, not solid).
 * One source, so collision cannot drift from what is drawn.
 */
import { SHELL_PARTS, type DungeonShell } from "./shell.js";

export interface ShellCollision {
  positions: Float32Array;
  indices: Uint32Array;
  triangles: number;
}

const SOLID_PARTS = new Set(["floor", "wall", "ceiling", "outer"]);

export function shellCollision(shell: DungeonShell): ShellCollision {
  const keep: number[] = [];
  for (let t = 0; t < shell.parts.length; t++) if (SOLID_PARTS.has(SHELL_PARTS[shell.parts[t]])) keep.push(t);
  const indices = new Uint32Array(keep.length * 3);
  keep.forEach((t, k) => {
    indices[k * 3] = shell.indices[t * 3];
    indices[k * 3 + 1] = shell.indices[t * 3 + 1];
    indices[k * 3 + 2] = shell.indices[t * 3 + 2];
  });
  return { positions: shell.positions, indices, triangles: keep.length };
}
