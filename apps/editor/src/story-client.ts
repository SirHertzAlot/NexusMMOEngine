/**
 * Browser-safe adapter for the Story workspace: HTTP to the dev host's
 * `/api/editor/story` routes (story-host.ts). Validation lives host-side
 * with the server's own schemas; a refused save comes back as
 * StorySaveError with every issue and nothing written.
 */

import { IssuesError, invalidMessage, requestJson } from "./api.js";
import { renameQuestId } from "./story-rename.js";
import { STORY_FILES, type StoryFiles, type StoryIssue, type StoryRefs } from "./story-validate.js";

export class StorySaveError extends IssuesError<StoryIssue> {
  constructor(issues: StoryIssue[]) {
    super(issues, invalidMessage("story", issues.filter((i) => i.severity === "error").length));
  }
}

const refused = (issues: StoryIssue[]): Error => new StorySaveError(issues);

/** All four documents and the rules references (item bases, species). */
export async function loadStory(base = ""): Promise<{ files: StoryFiles; refs: StoryRefs }> {
  const files = {} as StoryFiles;
  let refs: StoryRefs = { items: new Set(), species: new Set() };
  for (const name of STORY_FILES) {
    const body = await requestJson<{ content: unknown; refs: { items: string[]; species: string[] } }>(`${base}/api/editor/story/${name}`, {
      fail: `story ${name} read failed`,
      refused,
    });
    files[name] = body.content;
    refs = { items: new Set(body.refs.items), species: new Set(body.refs.species) };
  }
  return { files, refs };
}

/** Validate a whole candidate set on the host; nothing is written. */
export async function checkStoryRemote(files: StoryFiles, base = ""): Promise<StoryIssue[]> {
  return (await requestJson<{ issues: StoryIssue[] }>(`${base}/api/editor/story/check`, { body: { files }, fail: "story check failed", refused })).issues;
}

/** Save the changed documents together; throws StorySaveError when the set has errors. Returns warnings. */
export async function saveStory(changes: Partial<StoryFiles>, base = ""): Promise<StoryIssue[]> {
  return (await requestJson<{ issues: StoryIssue[] }>(`${base}/api/editor/story`, { method: "PUT", body: { files: changes }, fail: "story save failed", refused })).issues;
}

/** Rename a quest id everywhere it is named (quests, prerequisites, dialog replies); the host validates the renamed set and writes both files or neither. */
export async function renameQuestRemote(from: string, to: string, base = ""): Promise<void> {
  const { files } = await loadStory(base);
  await saveStory(renameQuestId(files, from, to), base);
}
