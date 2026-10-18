/**
 * Particle tier budgets form (roadmap EG10, Art & audio › VFX budgets):
 * content/vfx/budgets.json's caps per quality tier. The game client scales
 * emission to its tier's budget and the VFX editor warns when an effect is
 * over it. Browser-safe.
 */

import { DEFAULT_PARTICLE_BUDGETS, QUALITY_TIERS } from "@mmo-engine/art/browser";
import type { FieldSectionSpec } from "./rules-control.js";

const LABELS = { low: "Low", medium: "Medium", high: "High", ultra: "Ultra" } as const;

export const VFX_BUDGET_SECTIONS: FieldSectionSpec[] = QUALITY_TIERS.map((t) => ({
  title: `${LABELS[t]} quality`,
  fields: [
    { key: `tiers.${t}.maxParticles`, label: "Most live particles", kind: "number", int: true, min: 1, def: DEFAULT_PARTICLE_BUDGETS.tiers[t].maxParticles, help: t === "ultra" ? "8000 is the renderer's full capacity." : undefined },
    { key: `tiers.${t}.maxEmitters`, label: "Most emitters at once", kind: "number", int: true, min: 1, def: DEFAULT_PARTICLE_BUDGETS.tiers[t].maxEmitters },
  ],
}));
