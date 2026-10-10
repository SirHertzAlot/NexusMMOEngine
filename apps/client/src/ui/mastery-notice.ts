/**
 * Mastery notices (M4): a discipline earned (catalog 0x1b) and a weapon
 * taken by a parry (0x16 `disarmed`), as lines for the player.
 */

import type { HitMessage, SkillsMessage } from "@mmo-engine/protocol";
import { t } from "../i18n.js";

/** Disciplines in `next` that `prev` didn't have, as lines. The first message (no `prev`) says nothing. */
export function disciplineNotices(prev: SkillsMessage | null, next: SkillsMessage): string[] {
  if (!prev) return [];
  const had = new Set(prev.disciplines.map((d) => d.id));
  return next.disciplines
    .filter((d) => !had.has(d.id))
    .map((d) => t("mastery.earned", { name: d.name, hasUnlocks: d.unlocks.length > 0 ? "yes" : "no", unlocks: d.unlocks.join(", ") }));
}

/** A disarm the player took part in, or null. */
export function disarmNotice(h: HitMessage, me: string | null): string | null {
  if (!h.disarmed || me === null) return null;
  if (h.source === me) return t("mastery.youWereDisarmed");
  if (h.target === me) return t("mastery.youDisarmed");
  return null;
}
