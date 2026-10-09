/**
 * Medicine (M4, catalog 0x1a): a treatment's progress as a line for the
 * player, whether they are the healer, the patient, or both.
 */

import { t } from "../i18n.js";
import type { TreatmentMessage } from "@mmo-engine/protocol";

/** "legLeft" -> "left leg"-ish: the id spelled out ("leg left"); the body message has proper names. */
const spell = (part: string): string => part.replace(/([A-Z])/g, " $1").toLowerCase();

/** The line to show, or null when there is nothing to say. `me` is the player's own wire id. */
export function treatmentNotice(msg: TreatmentMessage, me: string | null, partName?: string): string | null {
  const part = (partName ?? spell(msg.part)).toLowerCase();
  const treatment = msg.treatment;
  if (msg.healer === me) {
    const whose = msg.patient === me ? "own" : "other";
    switch (msg.state) {
      case "started":
        return t("treat.started", { treatment, whose, part, time: msg.seconds ? t("notice.seconds", { n: Math.round(msg.seconds) }) : "" });
      case "done":
        return t("treat.done", { treatment, whose, part });
      case "failed":
        return t("treat.failed", { treatment, whose, part });
      case "stopped":
        return t("treat.stopped");
    }
  }
  switch (msg.state) {
    case "started":
      return t("treat.other-started", { treatment, part });
    case "done":
      return t("treat.other-done", { part });
    case "failed":
      return t("treat.other-failed", { part });
    case "stopped":
      return null;
  }
}
