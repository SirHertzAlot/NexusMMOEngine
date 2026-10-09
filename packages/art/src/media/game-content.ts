/**
 * The game's media content: six documents under content/ that the client
 * (and for combat, the server) read, and the editor's Animation, VFX and
 * Audio workspaces write.
 *
 *   combat     content/combat/moves.json         server + client
 *   animation  content/animation/animations.json client (v3 manifest: the locomotion graph)
 *   vfx        content/vfx/effects.json          client
 *   tiers      content/vfx/tiers.json            client
 *   materials  content/materials/materials.json  client
 *   audio      content/audio/events.json         client
 */
import { validateCombatMoves } from "@mmo-engine/protocol";
import type { CombatMove } from "@mmo-engine/protocol";
import { validateAudio, missingFootsteps, type AudioDoc } from "./audio.js";
import { checker, isObj, type MediaIssue } from "./issue.js";
import { validateLocomotion, type LocomotionGraph } from "./locomotion.js";
import { validateMaterials, type MaterialsDoc } from "./materials.js";
import { validateTiers, validateVfx, type TiersDoc, type VfxDoc } from "./vfx.js";

export const MEDIA_DOC_NAMES = ["combat", "animation", "vfx", "tiers", "materials", "audio"] as const;
export type MediaDocName = (typeof MEDIA_DOC_NAMES)[number];

/** content/animation/animations.json: a v3 manifest that carries only the locomotion graph (the clips come from the rig's own manifest). */
export interface AnimationDoc {
  version: 3;
  sources: [];
  clips: [];
  locomotion: LocomotionGraph;
}

export function validateAnimationDoc(doc: unknown): MediaIssue[] {
  const c = checker();
  if (!isObj(doc)) return [{ path: "", message: "animations must be an object" }];
  if (doc.version !== 3) c.add("version", "must be 3");
  for (const k of ["sources", "clips"]) if (!Array.isArray(doc[k]) || (doc[k] as unknown[]).length > 0) c.add(k, "must be an empty list (clips come from the rig's manifest)");
  return [...c.issues, ...validateLocomotion(doc.locomotion, "locomotion.")];
}

export const MEDIA_DOCS: Record<MediaDocName, { file: string; validate: (doc: unknown) => MediaIssue[] }> = {
  combat: { file: "combat/moves.json", validate: validateCombatMoves },
  animation: { file: "animation/animations.json", validate: validateAnimationDoc },
  vfx: { file: "vfx/effects.json", validate: validateVfx },
  tiers: { file: "vfx/tiers.json", validate: validateTiers },
  materials: { file: "materials/materials.json", validate: validateMaterials },
  audio: { file: "audio/events.json", validate: validateAudio },
};

/** What the game loads at start; a missing document keeps the engine's defaults. */
export interface GameContent {
  combat?: { version: 1; moves: CombatMove[] };
  animation?: AnimationDoc;
  vfx?: VfxDoc;
  tiers?: TiersDoc;
  materials?: MaterialsDoc;
  audio?: AudioDoc;
}

/** References between documents: audio events named by moves and surfaces must exist. */
export function crossCheck(c: GameContent): MediaIssue[] {
  const out: MediaIssue[] = [];
  const events = c.audio?.events;
  if (!events) return out;
  c.combat?.moves.forEach((m, i) => {
    for (const k of ["start", "hit"] as const) {
      const id = m.sound?.[k];
      if (id !== undefined && !(id in events)) out.push({ path: `combat: moves[${i}].sound.${k}`, message: `no audio event "${id}"` });
    }
  });
  if (c.materials) for (const i of missingFootsteps(c.materials.surfaces, c.audio!)) out.push({ ...i, path: `materials: ${i.path}` });
  return out;
}
