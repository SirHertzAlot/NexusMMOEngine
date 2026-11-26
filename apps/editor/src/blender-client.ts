/**
 * Browser side of the Blender live link (slice EU10): what has arrived,
 * and where the add-on is. The push itself comes from Blender, never
 * from here — the editor is the receiving end.
 */

import { requestJson } from "./api.js";
import type { LiveModel } from "./blender-link.js";

export interface BlenderLink {
  /** Repository-relative folder the models land in. */
  dir: string;
  /** Repository-relative path of the add-on to install in Blender. */
  addon: string;
  /** Newest push first. */
  models: LiveModel[];
}

export const blenderLink = (): Promise<BlenderLink> =>
  requestJson<BlenderLink>("/api/editor/blender", { fail: "read the Blender live link" });
