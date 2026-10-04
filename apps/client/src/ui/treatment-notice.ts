/**
 * Medicine (M4, catalog 0x1a): a treatment's progress as a line for the
 * player, whether they are the healer, the patient, or both.
 */

import type { TreatmentMessage } from "@mmo-engine/protocol";

const WORDS: Record<TreatmentMessage["treatment"], { doing: string; did: string; do: string }> = {
  bandage: { doing: "bandaging", did: "bandaged", do: "bandage" },
  stump: { doing: "closing the stump of", did: "closed the stump of", do: "close the stump of" },
  set: { doing: "setting", did: "set", do: "set" },
};

/** "legLeft" -> "left leg"-ish: the id spelled out ("leg left"); the body message has proper names. */
const spell = (part: string): string => part.replace(/([A-Z])/g, " $1").toLowerCase();

/** The line to show, or null when there is nothing to say. `me` is the player's own wire id. */
export function treatmentNotice(t: TreatmentMessage, me: string | null, partName?: string): string | null {
  const part = (partName ?? spell(t.part)).toLowerCase();
  const w = WORDS[t.treatment];
  if (t.healer === me) {
    const whose = t.patient === me ? "your" : "their";
    switch (t.state) {
      case "started":
        return `${w.doing[0].toUpperCase()}${w.doing.slice(1)} ${whose} ${part}${t.seconds ? ` (${Math.round(t.seconds)} s)` : ""}`;
      case "done":
        return `You ${w.did} ${whose} ${part}`;
      case "failed":
        return `You failed to ${w.do} ${whose} ${part}`;
      case "stopped":
        return "Treatment stopped";
    }
  }
  switch (t.state) {
    case "started":
      return `Someone is ${w.doing} your ${part}`;
    case "done":
      return `Your ${part} is treated`;
    case "failed":
      return `Treating your ${part} failed`;
    case "stopped":
      return null;
  }
}
