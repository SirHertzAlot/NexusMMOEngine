/**
 * Browser-safe adapter for the animation-side content documents (roadmap
 * EA21, EA22): HTTP to `/api/editor/media` (media-host.ts). A refused save
 * throws MediaSaveError carrying every problem by path.
 */
import type { AnimationManifest, GameContent, MediaDocName, MediaIssue } from "@mmo-engine/art/browser";
import { IssuesError, callEnvelope, invalidMessage } from "./api.js";

export class MediaSaveError extends IssuesError<MediaIssue> {
  constructor(issues: MediaIssue[]) {
    super(issues, invalidMessage("document", issues.length));
  }
}

const refused = (issues: MediaIssue[]): Error => new MediaSaveError(issues);

export async function getMedia<N extends MediaDocName>(name: N, base = ""): Promise<NonNullable<GameContent[N]>> {
  return (await callEnvelope<{ content: NonNullable<GameContent[N]> }>(`${base}/api/editor/media/${name}`, "GET")).content;
}

/** Every document, as the game view applies them. */
export async function getAllMedia(base = ""): Promise<GameContent> {
  return (await callEnvelope<{ content: GameContent }>(`${base}/api/editor/media`, "GET")).content;
}

/** Validate on the host and write only when valid; throws MediaSaveError otherwise. */
export async function saveMedia(name: MediaDocName, content: unknown, base = ""): Promise<void> {
  await callEnvelope(`${base}/api/editor/media/${name}`, "PUT", { content }, refused);
}

/** Where the rig's own animation manifest is served from (the dev host; absent where the art isn't). */
export const RIG_MANIFEST_URL = "/assets/models/glb/modular-fantasy-hero/Rigged/animations.json";

/** The rig's clips (null when the art isn't on this machine). */
export async function getRigManifest(url = RIG_MANIFEST_URL): Promise<AnimationManifest | null> {
  try {
    const res = await fetch(url);
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
    return (await res.json()) as AnimationManifest;
  } catch {
    return null;
  }
}

/** The names of the audio events a move or a surface can name (content/audio/events.json). */
export async function getAudioEventNames(base = ""): Promise<string[]> {
  try {
    const res = await fetch(`${base}/api/editor/audio`);
    if (!res.ok) return [];
    const body = (await res.json()) as { content?: { events?: Array<{ name?: unknown }> } };
    return (body.content?.events ?? []).map((e) => e.name).filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}
