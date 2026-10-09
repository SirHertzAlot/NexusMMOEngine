/**
 * The game's media content, applied at start: combat moves, the locomotion
 * graph, particle effects, quality tiers, toon and surface materials (the
 * audio document goes to the AudioEngine, which the caller holds). The
 * documents are content/*; in the client they arrive inlined by
 * vite-game-content.ts, in the editor's game view from its host. A document
 * that fails its checks is skipped with a warning, so a bad edit never
 * stops the client; everything else keeps the engine's defaults.
 */
import { MEDIA_DOCS, crossCheck, type GameContent, type MediaDocName } from "@mmo-engine/art/browser";
import { setCombatMoves } from "@mmo-engine/protocol";
import { setLocomotion } from "./character/character-animator.js";
import { setParticleLooks } from "./fx/particle-fx.js";
import { setQualityPresets, type QualitySettings, type QualityTier } from "./quality.js";
import { setSurfaceMaterials } from "./terrain/surfaces.js";
import { setToonContent } from "./toon/toon-material.js";
import { setParticleEffects } from "./vfx/quarks-fx.js";

let current: GameContent = {};

/** The content applied last (the audio hooks and footsteps read it). */
export function gameContent(): GameContent {
  return current;
}

/** Apply `c`; returns the names applied and the problems that kept a document out. */
export function applyGameContent(c: GameContent): { applied: MediaDocName[]; problems: string[] } {
  const applied: MediaDocName[] = [];
  const problems: string[] = [];
  const ok = (name: MediaDocName): boolean => {
    const doc = c[name];
    if (doc === undefined) return false;
    const issues = MEDIA_DOCS[name].validate(doc);
    for (const i of issues) problems.push(`${MEDIA_DOCS[name].file}: ${i.path}: ${i.message}`);
    return issues.length === 0;
  };
  const good: GameContent = {};
  if (ok("combat")) {
    setCombatMoves(c.combat);
    good.combat = c.combat;
    applied.push("combat");
  }
  if (ok("animation")) {
    setLocomotion(c.animation!.locomotion);
    good.animation = c.animation;
    applied.push("animation");
  }
  if (ok("vfx")) {
    const v = c.vfx!;
    setParticleEffects(v.effects);
    setParticleLooks(v.weather, v.splash);
    good.vfx = v;
    applied.push("vfx");
  }
  if (ok("tiers")) {
    const t = c.tiers!.tiers;
    setQualityPresets(t as Record<QualityTier, QualitySettings>);
    good.tiers = c.tiers;
    applied.push("tiers");
  }
  if (ok("materials")) {
    setToonContent(c.materials!.toon);
    setSurfaceMaterials(c.materials!.surfaces);
    good.materials = c.materials;
    applied.push("materials");
  }
  if (ok("audio")) {
    good.audio = c.audio;
    applied.push("audio");
  }
  for (const i of crossCheck(good)) problems.push(`${i.path}: ${i.message}`);
  current = good;
  for (const p of problems) console.warn(`[client] content: ${p}`);
  return { applied, problems };
}
