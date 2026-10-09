/**
 * Footsteps: a step each `stride` metres walked on the ground, on the
 * surface under the feet. Pure (no audio): the world's frame loop feeds it
 * the ground speed, and plays the event it returns.
 */
import type { AudioDoc, MaterialsDoc } from "@mmo-engine/art/browser";

/** The terrain layer each biome shows (apps/client/scripts/fetch-surfaces.mjs BIOMES). */
export const BIOME_SURFACE: Record<string, string> = {
  plains: "grass",
  forest: "forest-floor",
  rainforest: "moss",
  desert: "dune-sand",
  beach: "beach-sand",
  swamp: "mud",
  mountains: "rocky-ground",
  tundra: "tundra",
  snow: "snow",
  glacier: "snow",
  volcanic: "volcanic",
  sea: "beach-sand",
  lake: "mud",
};

/** The footstep event for a biome: its surface's (materials.json), else the fallback (audio hooks). */
export function footstepEvent(biome: string | null, materials: Pick<MaterialsDoc, "surfaces"> | undefined, audio: Pick<AudioDoc, "hooks">): string {
  const surface = biome ? BIOME_SURFACE[biome] : undefined;
  return (surface && materials?.surfaces[surface]?.footstep) || audio.hooks.footstep.fallback;
}

export class Footsteps {
  private walked = 0;

  /** Advance by `dt` seconds at `speed` m/s on the ground (`grounded`); returns true when a step falls in it. */
  step(dt: number, speed: number, grounded: boolean, stride: number): boolean {
    if (!grounded || speed < 0.3) {
      // Standing still: the next move starts with a step soon, not after a whole stride.
      this.walked = Math.max(this.walked, stride * 0.6);
      return false;
    }
    this.walked += speed * dt;
    if (this.walked < stride) return false;
    this.walked -= stride;
    return true;
  }
}
