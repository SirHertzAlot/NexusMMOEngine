/**
 * Browser-safe adapter for the Story workspace: HTTP to the dev host's
 * `/api/editor/story` routes (story-host.ts). Validation lives host-side
 * with the server's own schemas; a refused save comes back as
 * StorySaveError with every issue and nothing written.
 */

import { renameQuestId } from "./story-rename.js";
import { STORY_FILES, type StoryFiles, type StoryIssue, type StoryRefs } from "./story-validate.js";

export class StorySaveError extends Error {
  constructor(readonly issues: StoryIssue[]) {
    super(`invalid story: ${issues.filter((i) => i.severity === "error").length} problem(s)`);
    this.name = "StorySaveError";
  }
}

async function failure(res: Response, what: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: string; issues?: StoryIssue[] };
    if (res.status === 400 && Array.isArray(body.issues)) return new StorySaveError(body.issues);
    if (body.error) return new Error(body.error);
  } catch {
    /* fall through */
  }
  return new Error(`${what}: HTTP ${res.status}`);
}

/** All four documents and the rules references (item bases, species). */
export async function loadStory(base = ""): Promise<{ files: StoryFiles; refs: StoryRefs }> {
  const files = {} as StoryFiles;
  let refs: StoryRefs = { items: new Set(), species: new Set() };
  for (const name of STORY_FILES) {
    const res = await fetch(`${base}/api/editor/story/${name}`);
    if (!res.ok) throw await failure(res, `story ${name} read failed`);
    const body = (await res.json()) as { content: unknown; refs: { items: string[]; species: string[] } };
    files[name] = body.content;
    refs = { items: new Set(body.refs.items), species: new Set(body.refs.species) };
  }
  return { files, refs };
}

const post = (url: string, method: string, body: unknown): Promise<Response> =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Validate a whole candidate set on the host; nothing is written. */
export async function checkStoryRemote(files: StoryFiles, base = ""): Promise<StoryIssue[]> {
  const res = await post(`${base}/api/editor/story/check`, "POST", { files });
  if (!res.ok) throw await failure(res, "story check failed");
  return ((await res.json()) as { issues: StoryIssue[] }).issues;
}

/** Save the changed documents together; throws StorySaveError when the set has errors. Returns warnings. */
export async function saveStory(changes: Partial<StoryFiles>, base = ""): Promise<StoryIssue[]> {
  const res = await post(`${base}/api/editor/story`, "PUT", { files: changes });
  if (!res.ok) throw await failure(res, "story save failed");
  return ((await res.json()) as { issues: StoryIssue[] }).issues;
}

/** Rename a quest id everywhere it is named (quests, prerequisites, dialog replies); the host validates the renamed set and writes both files or neither. */
export async function renameQuestRemote(from: string, to: string, base = ""): Promise<void> {
  const { files } = await loadStory(base);
  await saveStory(renameQuestId(files, from, to), base);
}
