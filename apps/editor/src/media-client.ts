/**
 * Browser-safe adapter for the media documents (roadmap EA21, EA22, EA24):
 * plain HTTP to `/api/editor/media` (media-host.ts). A refused save throws
 * MediaSaveError carrying every problem by path.
 */
import type { AnimationManifest, GameContent, MediaDocName, MediaIssue } from "@mmo-engine/art/browser";

export class MediaSaveError extends Error {
  constructor(readonly issues: MediaIssue[]) {
    super(`refused: ${issues.length} problem${issues.length === 1 ? "" : "s"}`);
    this.name = "MediaSaveError";
  }
}

async function readError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: unknown; issues?: unknown };
    if (res.status === 400 && Array.isArray(body.issues)) return new MediaSaveError(body.issues as MediaIssue[]);
    if (typeof body.error === "string" && body.error) return new Error(body.error);
  } catch {
    /* fall through */
  }
  return new Error(`${fallback}: HTTP ${res.status}`);
}

export async function getMedia<N extends MediaDocName>(name: N, base = ""): Promise<NonNullable<GameContent[N]>> {
  const res = await fetch(`${base}/api/editor/media/${name}`);
  if (!res.ok) throw await readError(res, `${name} read failed`);
  return ((await res.json()) as { content: NonNullable<GameContent[N]> }).content;
}

/** Every document, as the game view applies them. */
export async function getAllMedia(base = ""): Promise<GameContent> {
  const res = await fetch(`${base}/api/editor/media`);
  if (!res.ok) throw await readError(res, "media read failed");
  return ((await res.json()) as { content: GameContent }).content;
}

/** Validate on the host and write only when valid; throws MediaSaveError otherwise. */
export async function saveMedia(name: MediaDocName, content: unknown, base = ""): Promise<void> {
  const res = await fetch(`${base}/api/editor/media/${name}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw await readError(res, `${name} save failed`);
}

/** Where the rig's own animation manifest is served from (the dev server; absent where the art isn't). */
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
