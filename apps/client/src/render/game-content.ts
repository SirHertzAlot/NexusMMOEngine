/**
 * The animation-side game content, applied at start: combat moves, the
 * locomotion graph, toon and surface materials. The documents are
 * content/*; in the client they arrive inlined by vite (virtual:combat-moves
 * and friends), in the editor's game view from its host. A document that
 * fails its checks is skipped with a warning, so a bad edit never stops the
 * client; everything else keeps the engine's defaults. (Audio, particle
 * effects and their budgets load through their own paths.)
 */
import { MEDIA_DOCS, type GameContent, type MediaDocName } from "@mmo-engine/art/browser";
import { setCombatMoves } from "@mmo-engine/protocol";
import { setLocomotion } from "./character/character-animator.js";
import { setSurfaceMaterials } from "./terrain/surfaces.js";
import { setToonContent } from "./toon/toon-material.js";
import { setShadingContent } from "./shading/shading.js";

let current: GameContent = {};

/** The content applied last (footsteps read the materials). */
export function gameContent(): GameContent {
  return current;
}

/** Apply `c`; returns the names applied and the problems that kept a document out. */
export function applyGameContent(c: GameContent): { applied: MediaDocName[]; problems: string[] } {
  const applied: MediaDocName[] = [];
  const problems: string[] = [];
  const good: GameContent = {};
  const ok = (name: MediaDocName): boolean => {
    const doc = c[name];
    if (doc === undefined) return false;
    const issues = MEDIA_DOCS[name].validate(doc);
    for (const i of issues) problems.push(`${MEDIA_DOCS[name].file}: ${i.path}: ${i.message}`);
    return issues.length === 0;
  };
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
  if (ok("materials")) {
    setToonContent(c.materials!.toon);
    setSurfaceMaterials(c.materials!.surfaces);
    setShadingContent(c.materials!.shading);
    good.materials = c.materials;
    applied.push("materials");
  }
  current = good;
  for (const p of problems) console.warn(`[client] content: ${p}`);
  return { applied, problems };
}
