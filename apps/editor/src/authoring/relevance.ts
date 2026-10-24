/**
 * Relevance evaluation — audit §5, rules 1–18, as code.
 *
 * Selection summons modules: given the facts of one selection, decide
 * which module widgets are applied to it. The two audit merge pairs are
 * resolved here, once: character+characters (rules 2+12) and
 * quests+story (rules 7+16) each produce ONE widget with tabs — the same
 * invariant the Phase A merged modals established in the UI.
 *
 * Scene-level-only modules (chat rule 10, hud rule 14, scenes rule 15)
 * never appear on an object selection; they are reported separately so
 * the UI can show them on scene selection instead. Flow/vfx/audio
 * (rules 13/17/11) join object selection through their Phase A marker
 * components. sample-heartbeat (rule 18) never produces a widget.
 */

import { hasComponent, type SelectionFacts } from "./facts.js";

/** Every module id the authoring layer knows, including merged and scene-level ones. */
export type ModuleId =
  | "transform"
  | "vendor"
  | "character"
  | "combat"
  | "creatures"
  | "physics"
  | "items"
  | "quests"
  | "dungeons"
  | "intent"
  | "flow"
  | "vfx"
  | "audio"
  | "chat"
  | "hud"
  | "scenes"
  | "sample-heartbeat";

export interface AppliedWidget {
  /** The widget's id — for merged pairs this is the merged widget, not a module. */
  widgetId: string;
  /** Module(s) the widget fronts. Merged pairs list both. */
  modules: readonly ModuleId[];
  /** Designer-language title ("Vendor", "Character", "Quests & dialogue"). */
  title: string;
  /** Audit §5 rule numbers that fired. */
  rules: readonly number[];
  /** Tab labels when the widget merges two modules; undefined for a single-module widget. */
  tabs?: readonly string[];
  /** One line on what the widget shows for this selection (the "what's applied" summary seed). */
  detail: string;
}

export interface RelevanceResult {
  applied: readonly AppliedWidget[];
  /** Modules that are scene-level only and therefore excluded from this object selection. */
  sceneLevelOnly: readonly ModuleId[];
}

/** Modules that can only ever appear on scene/region selection (audit rules 10, 14, 15). */
export const SCENE_LEVEL_MODULES: readonly ModuleId[] = ["chat", "hud", "scenes"];

/**
 * Evaluate rules 1–18 against one object selection.
 * Order is presentation order: identity first (transform), person next,
 * then behaviour, then markers.
 */
export function evaluateRelevance(facts: SelectionFacts): RelevanceResult {
  const applied: AppliedWidget[] = [];
  const push = (w: AppliedWidget): void => {
    applied.push(w);
  };

  // Base identity: every placed object carries a transform; the design's
  // click flow ("clicking a rock yields transform + physics only") treats
  // it as the always-present widget, not a module from the audit table.
  if (hasComponent(facts, "Transform")) {
    push({ widgetId: "transform", modules: ["transform"], title: "Transform", rules: [], detail: "Position, rotation and scale of the placed object." });
  }

  // Rule 1 — core/economy: in the vendor map.
  if (facts.isVendor) {
    push({
      widgetId: "vendor",
      modules: ["vendor"],
      title: "Vendor",
      rules: [1],
      detail: facts.vendorTemplateId ? `Vendor · template \`${facts.vendorTemplateId}\`` : "Vendor · template attached",
    });
  }

  // Rules 2 + 12 — character (server) and characters (editor Records) MERGED.
  if (hasComponent(facts, "CharacterRef")) {
    push({
      widgetId: "character",
      modules: ["character"],
      title: "Character",
      rules: [2, 12],
      tabs: ["Sheet", "Records"],
      detail: "Character sheet (stats, mastery, animation) and records, in one widget.",
    });
  }

  // Rule 3 — combat: Health or Stamina present.
  if (hasComponent(facts, "Health") || hasComponent(facts, "Stamina")) {
    push({ widgetId: "combat", modules: ["combat"], title: "Combat", rules: [3], detail: "Abilities, status effects, health and stamina." });
  }

  // Rule 4 — creatures: kindOf returned a kind.
  if (facts.creatureKind !== undefined) {
    push({ widgetId: "creature", modules: ["creatures"], title: "Creature", rules: [4], detail: `Creature · kind \`${facts.creatureKind}\` — AI state and needs.` });
  }

  // Rule 5 — physics: a collider, or a NavAgent.
  if (facts.hasCollider || hasComponent(facts, "NavAgent")) {
    push({ widgetId: "physics", modules: ["physics"], title: "Physics", rules: [5], detail: "Collider shape and navigation-agent state." });
  }

  // Rule 6 — items: a world item shows its def/owner/timer; a character shows bag CRUD.
  if (hasComponent(facts, "WorldItem")) {
    push({ widgetId: "items", modules: ["items"], title: "Item", rules: [6], detail: "World item: def, owner and despawn timer." });
  } else if (hasComponent(facts, "CharacterRef")) {
    push({ widgetId: "items", modules: ["items"], title: "Bag", rules: [6], detail: "Bag and inventory for this character." });
  }

  // Rules 7 + 16 — quests (server) and story (editor) MERGED.
  if (facts.isQuestGiver) {
    push({
      widgetId: "quests",
      modules: ["quests"],
      title: "Quests & dialogue",
      rules: [7, 16],
      tabs: ["Quests", "Dialogue"],
      detail: facts.questIds && facts.questIds.length > 0 ? `Gives ${facts.questIds.length} quest(s), with its dialogue graph.` : "Quests given by this NPC, with its dialogue graph.",
    });
  }

  // Rule 8 — dungeons: an entrance.
  if (facts.isDungeonEntrance) {
    push({ widgetId: "dungeons", modules: ["dungeons"], title: "Dungeon entrance", rules: [8], detail: "Entrance pools, rank and themes." });
  }

  // Rule 9 — intent: player avatars only.
  if (hasComponent(facts, "PlayerIntent")) {
    push({ widgetId: "intent", modules: ["intent"], title: "Intent", rules: [9], detail: "Per-session intent and pickup budgets, frame cap." });
  }

  // Rule 13 — flow: the FlowRef marker (Phase A) binds a graph to this object.
  if (facts.flowRef !== undefined) {
    push({ widgetId: "flow", modules: ["flow"], title: "Flow behaviour", rules: [13], detail: `Flow graph \`${facts.flowRef}\` bound to this object.` });
  }

  // Rule 17 — vfx: the VfxEmitter marker (Phase A).
  if (facts.vfxEmitter !== undefined) {
    push({ widgetId: "vfx", modules: ["vfx"], title: "Effects", rules: [17], detail: `Particle emitter \`${facts.vfxEmitter}\` on this object.` });
  }

  // Rule 11 — audio: the AudioEmitter marker (Phase A) makes audio per-object;
  // without it audio stays scene-level (ambient/music), listed below.
  if (facts.audioEmitter !== undefined) {
    push({ widgetId: "audio", modules: ["audio"], title: "Audio", rules: [11], detail: `Audio emitter \`${facts.audioEmitter}\` on this object.` });
  }

  // Rules 10, 14, 15 (chat, hud, scenes) and 18 (sample-heartbeat: nothing)
  // produce no object widget — by rule, not by omission.
  return { applied, sceneLevelOnly: SCENE_LEVEL_MODULES };
}

/** Widgets for a scene/region selection: the scene-level modules only. */
export function sceneLevelWidgets(): readonly AppliedWidget[] {
  return [
    { widgetId: "scenes", modules: ["scenes"], title: "Scene", rules: [15], detail: "The scene document — this selection IS the hierarchy root." },
    { widgetId: "chat", modules: ["chat"], title: "Chat", rules: [10], detail: "Region channels, range and rate limits." },
    { widgetId: "hud", modules: ["hud"], title: "HUD", rules: [14], detail: "Global HUD layout. Never selection-driven beyond the scene." },
    { widgetId: "audio", modules: ["audio"], title: "Audio", rules: [11], detail: "Scene ambient and music (per-object audio needs an AudioEmitter marker)." },
  ];
}
