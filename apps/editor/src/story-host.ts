/**
 * Quest and dialog document storage for the editor dev host (roadmap EA20).
 *
 * Same posture as rules-host.ts. Loopback routes (wired in host.ts):
 *
 *   GET /api/editor/story         → { files: ["quests", "dialogs", "npcs", "steps"] }
 *   GET /api/editor/story/:name   → { name, content, refs }  (refs: item bases and species)
 *   PUT /api/editor/story/:name   → { content } → validate the whole set, then write
 *   POST /api/editor/story/check  → { files } → issues, nothing written
 *
 * - The name is whitelisted against STORY_FILES, never a raw path, and the
 *   resolved path is confined to <repo>/content/quests.
 * - The documents are the files the server loads (content/quests/*.json);
 *   no new format. A save validates the candidate in place of its file next
 *   to the on-disk siblings with the server's own schemas and checks
 *   (story-validate.ts) and writes (atomically) only when there is no error.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { STORY_FILES, validateStory, type QuestServer, type StoryFile, type StoryFiles, type StoryIssue, type StoryRefs } from "./story-validate.js";

export function storyFileNames(): StoryFile[] {
  return [...STORY_FILES];
}

export function isStoryFile(name: string): name is StoryFile {
  return (STORY_FILES as readonly string[]).includes(name);
}

export function storyDir(repoRoot: string): string {
  return resolve(repoRoot, "content", "quests");
}

/** Absolute path of a story file; throws { status: 404 } for any name off the whitelist. */
export function resolveStoryPath(repoRoot: string, name: string): string {
  if (!isStoryFile(name)) {
    throw Object.assign(new Error(`unknown story file "${name}" (expected one of: ${STORY_FILES.join(", ")})`), { status: 404 });
  }
  const dir = storyDir(repoRoot);
  const abs = join(dir, `${name}.json`);
  if (!abs.startsWith(dir + sep)) throw Object.assign(new Error("path escapes quests root"), { status: 500 });
  return abs;
}

const servers = new Map<string, Promise<QuestServer>>();

/** The server's own quest schemas and cross-file check, from engine-core's build. */
export function loadQuestServer(repoRoot: string): Promise<QuestServer> {
  let p = servers.get(repoRoot);
  if (!p) {
    const file = join(repoRoot, "packages", "engine-core", "dist", "src", "quests", "content.js");
    p = import(pathToFileURL(file).href).then(
      (m: { StepsFileSchema: unknown; QuestsFileSchema: unknown; NpcsFileSchema: unknown; DialogsFileSchema: unknown; checkQuestContent: QuestServer["check"] }) => ({
        schemas: { steps: m.StepsFileSchema, quests: m.QuestsFileSchema, npcs: m.NpcsFileSchema, dialogs: m.DialogsFileSchema } as QuestServer["schemas"],
        check: m.checkQuestContent,
      }),
      (e: unknown) => {
        servers.delete(repoRoot);
        throw Object.assign(new Error(`the server's quest loader isn't built (npm run build -w @mmo-engine/engine-core): ${(e as Error).message}`), { status: 500 });
      },
    );
    servers.set(repoRoot, p);
  }
  return p;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** Item bases and species the quests may name (content/rules items.bases and creatures). */
export function readStoryRefs(repoRoot: string): StoryRefs {
  const keys = (file: string, field: string): Set<string> => {
    const p = join(repoRoot, "content", "rules", file);
    if (!existsSync(p)) return new Set();
    const v = (readJson(p) as Record<string, unknown>)[field];
    return new Set(v && typeof v === "object" ? Object.keys(v) : []);
  };
  return { items: keys("items.json", "bases"), species: keys("creatures.json", "creatures") };
}

export function readStoryFile(repoRoot: string, name: string): { name: StoryFile; content: unknown; refs: { items: string[]; species: string[] } } {
  const file = resolveStoryPath(repoRoot, name);
  let content: unknown;
  try {
    content = readJson(file);
  } catch (e) {
    throw Object.assign(new Error(`${name}.json: ${(e as Error).message}`), { status: 500 });
  }
  const refs = readStoryRefs(repoRoot);
  return { name: name as StoryFile, content, refs: { items: [...refs.items], species: [...refs.species] } };
}

/** Validate `candidate` (all four files, as given) against the rules on disk. */
export async function checkStory(repoRoot: string, candidate: StoryFiles): Promise<StoryIssue[]> {
  return validateStory(candidate, readStoryRefs(repoRoot), await loadQuestServer(repoRoot));
}

/** The set on disk with the `changes` in place of their files. */
function withSiblings(repoRoot: string, changes: Partial<StoryFiles>): StoryFiles {
  const out = {} as StoryFiles;
  for (const f of STORY_FILES) out[f] = f in changes ? changes[f] : readJson(resolveStoryPath(repoRoot, f));
  return out;
}

/**
 * Validate the whole set with `changes` in place of their files, then write
 * them (files that need each other, like a new quest and the dialog that
 * offers it, go together). Throws { status: 400, issues } when the set has
 * errors: nothing is written. Returns the warnings of a save that went through.
 */
export async function saveStoryFiles(repoRoot: string, changes: Partial<StoryFiles>): Promise<StoryIssue[]> {
  const names = Object.keys(changes);
  const paths = names.map((n) => resolveStoryPath(repoRoot, n));
  const issues = await checkStory(repoRoot, withSiblings(repoRoot, changes));
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length > 0) {
    throw Object.assign(new Error(`invalid story: ${errors.length} problem${errors.length === 1 ? "" : "s"}`), { status: 400, issues });
  }
  names.forEach((n, i) => {
    const tmp = `${paths[i]}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(changes[n as StoryFile], null, 2)}
`, "utf8");
    renameSync(tmp, paths[i]);
  });
  return issues;
}

export function saveStoryFile(repoRoot: string, name: string, content: unknown): Promise<StoryIssue[]> {
  return saveStoryFiles(repoRoot, { [name]: content });
}
