/**
 * Browser-safe adapter for the Animation panel (roadmap EA21): HTTP to the dev
 * host's `/api/editor/animation/clips` (animation-host.ts). Validation lives
 * host-side with art's `checkClipMap`; a refused save comes back as
 * AnimationSaveError with every issue and nothing written.
 */
import type { ClipMap, ClipMapIssue } from "@mmo-engine/art";
import { callEnvelope, IssuesError, invalidMessage } from "./api.js";

export class AnimationSaveError extends IssuesError<ClipMapIssue> {
  constructor(issues: ClipMapIssue[]) {
    super(issues, invalidMessage("clip map", issues.length));
  }
}

const refused = (issues: ClipMapIssue[]): Error => new AnimationSaveError(issues);

export const getClipMap = (base = ""): Promise<{ map: ClipMap; saved: boolean }> =>
  callEnvelope(`${base}/api/editor/animation/clips`, "GET");

/** Validate on the host and write only when valid; throws AnimationSaveError otherwise. */
export const saveClipMap = async (map: ClipMap, base = ""): Promise<void> =>
  void (await callEnvelope(`${base}/api/editor/animation/clips`, "PUT", { map }, refused));
