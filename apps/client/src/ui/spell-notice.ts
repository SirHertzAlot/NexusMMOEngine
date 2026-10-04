/**
 * Spell notices (catalog 0x1c): a cast's progress as a line for the
 * caster or the one it is cast on.
 */

import type { SpellMessage } from "@mmo-engine/protocol";

/** "mend" -> "Mend". */
const title = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1).replace(/([A-Z])/g, " $1");

/** The line to show, or null when there is nothing to say. `me` is the player's own wire id. */
export function spellNotice(s: SpellMessage, me: string | null, name = title(s.spell)): string | null {
  const self = s.caster === s.target;
  if (s.caster === me) {
    switch (s.state) {
      case "started":
        return `Casting ${name}${s.seconds ? ` (${Math.round(s.seconds)} s)` : ""}`;
      case "done":
        return s.amount !== undefined ? `${name} healed ${self ? "you" : "them"} for ${Math.round(s.amount)}` : `${name} cast`;
      case "stopped":
        return "Cast stopped";
    }
  }
  if (s.target !== me) return null;
  switch (s.state) {
    case "started":
      return `Someone is casting ${name} on you`;
    case "done":
      return s.amount !== undefined ? `${name} healed you for ${Math.round(s.amount)}` : null;
    case "stopped":
      return null;
  }
}
