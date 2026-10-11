/**
 * Spell notices (catalog 0x1c): a cast's progress as a line for the
 * caster or the one it is cast on.
 */

import type { SpellMessage } from "@mmo-engine/protocol";
import { t } from "../i18n.js";

/** "mend" -> "Mend". */
export const spellTitle = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1).replace(/([A-Z])/g, " $1");

/** The line to show, or null when there is nothing to say. `me` is the player's own wire id. */
export function spellNotice(s: SpellMessage, me: string | null, name = spellTitle(s.spell)): string | null {
  const self = s.caster === s.target;
  if (s.caster === me) {
    switch (s.state) {
      case "started":
        return t("spell.casting", { name, timed: s.seconds ? "yes" : "no", seconds: Math.round(s.seconds ?? 0) });
      case "done":
        return s.amount !== undefined ? t("spell.healed", { name, who: self ? "self" : "other", amount: Math.round(s.amount) }) : t("spell.cast", { name });
      case "stopped":
        return t("spell.stopped");
    }
  }
  if (s.target !== me) return null;
  switch (s.state) {
    case "started":
      return t("spell.castingOnYou", { name });
    case "done":
      return s.amount !== undefined ? t("spell.healedYou", { name, amount: Math.round(s.amount) }) : null;
    case "stopped":
      return null;
  }
}
