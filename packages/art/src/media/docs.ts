/**
 * The animation-side content documents the game reads and the editor's
 * Animation panel writes (roadmap EA21, EA22):
 *
 *   combat     content/combat/moves.json          server + client
 *   animation  content/animation/animations.json  client (v3 manifest: the locomotion graph)
 *   materials  content/materials/materials.json   client (toon look, surface tints, footsteps, shading)
 *
 * Audio, particle effects and their budgets have their own documents,
 * hosts and panels (content/audio, content/vfx); references to audio
 * events are checked by the editor host against those.
 */
import { validateCombatMoves } from "@mmo-engine/protocol";
import type { CombatMove } from "@mmo-engine/protocol";
import { checker, isObj, type MediaIssue } from "./issue.js";
import { validateLocomotion, type LocomotionGraph } from "./locomotion.js";
import { validateMaterials, type MaterialsDoc } from "./materials.js";

export const MEDIA_DOC_NAMES = ["combat", "animation", "materials"] as const;
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
  materials: { file: "materials/materials.json", validate: validateMaterials },
};

export interface GameContent {
  combat?: { version: 1; moves: CombatMove[] };
  animation?: AnimationDoc;
  materials?: MaterialsDoc;
}

/** Audio events the documents name (a move's sounds, a surface's footstep) that `events` lacks. */
export function missingAudioEvents(c: GameContent, events: ReadonlySet<string>): MediaIssue[] {
  const out: MediaIssue[] = [];
  c.combat?.moves.forEach((m, i) => {
    for (const k of ["start", "hit"] as const) {
      const id = m.sound?.[k];
      if (id !== undefined && !events.has(id)) out.push({ path: `combat: moves[${i}].sound.${k}`, message: `no audio event "${id}"` });
    }
  });
  for (const [id, s] of Object.entries(c.materials?.surfaces ?? {})) {
    if (s.footstep !== undefined && !events.has(s.footstep)) out.push({ path: `materials: surfaces.${id}.footstep`, message: `no audio event "${s.footstep}"` });
  }
  return out;
}
