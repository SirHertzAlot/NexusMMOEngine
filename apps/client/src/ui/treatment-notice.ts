/**
 * Medicine (M4, catalog 0x1a): a treatment's progress as a line for the
 * player, whether they are the healer, the patient, or both.
 */

import type { TreatmentMessage } from "@mmo-engine/protocol";
import { t } from "../i18n.js";

/** "legLeft" -> "left leg"-ish: the id spelled out ("leg left"); the body message has proper names. */
const spell = (part: string): string => part.replace(/([A-Z])/g, " $1").toLowerCase();

/** The line to show, or null when there is nothing to say. `me` is the player's own wire id. */
export function treatmentNotice(msg: TreatmentMessage, me: string | null, partName?: string): string | null {
  const part = (partName ?? spell(msg.part)).toLowerCase();
  const treatment = msg.treatment;
  if (msg.healer === me) {
    const whose = msg.patient === me ? "self" : "other";
    switch (msg.state) {
      case "started":
        return t("treatment.started", { treatment, whose, part, timed: msg.seconds ? "yes" : "no", seconds: Math.round(msg.seconds ?? 0) });
      case "done":
        return t("treatment.done", { treatment, whose, part });
      case "failed":
        return t("treatment.failed", { treatment, whose, part });
      case "stopped":
        return t("treatment.stopped");
    }
  }
  switch (msg.state) {
    case "started":
      return t("treatment.startedOnYou", { treatment, part });
    case "done":
      return t("treatment.doneOnYou", { part });
    case "failed":
      return t("treatment.failedOnYou", { part });
    case "stopped":
      return null;
  }
}
