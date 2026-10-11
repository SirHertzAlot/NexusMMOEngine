/**
 * The editor's Problems list: every validator the host already runs on a
 * save, run over what is on disk now, as one flat list.
 *
 *   GET /api/editor/problems → { ok, problems: Problem[], errors, warnings }
 *
 * Read-only. Each source is its own collector, run in a try: content that is
 * simply absent adds nothing, and a validator that cannot run (a package not
 * built) becomes one warning for its source instead of failing the list.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkClipMap } from "@mmo-engine/art";
import { loadProfile } from "@mmo-engine/build";
import { validateFlow, validateScene, validateTables } from "@mmo-engine/scene";
import { handleFlowRoute } from "./flow-host.js";
import { validateHudLayout } from "./ui/hud-editor-logic.js";
import { readStrings } from "./strings-host.js";
import { audioFile, checkAudio } from "./audio-host.js";
import { checkVfx, vfxDir } from "./vfx-host.js";
import { readClipMap } from "./animation-host.js";
import { checkGameplay, readGameplay } from "./gameplay-host.js";
import { GAMEPLAY_TABLES } from "./gameplay-tables.js";
import { checkRuleSave, readRuleFile, ruleFileNames } from "./rules-host.js";
import { listScenes, readScene } from "./scenes-host.js";
import { handleModulesRoute } from "./modules-host.js";
import { STORY_FILES, type StoryFiles } from "./story-validate.js";
import { checkStory, readStoryFile } from "./story-host.js";

export type ProblemSource = "flow" | "hud" | "strings" | "audio" | "vfx" | "animation" | "gameplay" | "rules" | "scenes" | "modules" | "story" | "build" | "playtest";
export interface Problem {
  source: ProblemSource;
  /** Repo-relative file (or a name) the problem belongs to. */
  file: string;
  severity: "error" | "warning";
  message: string;
}

type Issue = { path?: string; message: string };
const at = (i: Issue): string => (i.path ? `${i.path}: ${i.message}` : i.message);
const errs = (source: ProblemSource, file: string, issues: Issue[]): Problem[] =>
  issues.map((i) => ({ source, file, severity: "error", message: at(i) }));
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const jsonFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []);
const oneError = (source: ProblemSource, file: string, e: unknown): Problem[] =>
  errs(source, file, [{ message: e instanceof Error ? e.message : String(e) }]);

export type Collector = [ProblemSource, () => Problem[] | Promise<Problem[]>];

export function problemCollectors(repoRoot: string): Collector[] {
  return [
    ["flow", () => {
      const r = handleFlowRoute(repoRoot, "GET", "/api/editor/flow", undefined);
      if (!r || r.status !== 200) return []; // no flow file: the client falls back to its built-in flow
      const b = r.body as { content: unknown; scenes: string[] };
      return errs("flow", "content/flow/game.flow.json", validateFlow(b.content, { scenes: b.scenes }));
    }],
    ["hud", () => {
      const file = join(repoRoot, "content", "ui", "hud.json");
      return existsSync(file) ? errs("hud", "content/ui/hud.json", validateHudLayout(readJson(file)).map((message) => ({ message }))) : [];
    }],
    ["strings", () =>
      validateTables(readStrings(repoRoot)).map((i) => ({
        source: "strings" as const,
        file: `content/strings/${i.lang}.json`,
        severity: "error" as const,
        message: i.id ? `${i.id}: ${i.message}` : i.message,
      })),
    ],
    ["audio", async () => (existsSync(audioFile(repoRoot)) ? errs("audio", "content/audio/events.json", await checkAudio(repoRoot, readJson(audioFile(repoRoot)))) : [])],
    ["vfx", async () => {
      const out: Problem[] = [];
      for (const f of jsonFiles(vfxDir(repoRoot))) out.push(...errs("vfx", `content/vfx/effects/${f}`, await checkVfx(repoRoot, readJson(join(vfxDir(repoRoot), f)))));
      return out;
    }],
    ["animation", () => errs("animation", "content/animation/clips.json", checkClipMap(readClipMap(repoRoot).map).filter((i) => i.severity === "error"))],
    ["rules", () => {
      const out: Problem[] = [];
      for (const name of ruleFileNames()) {
        for (const i of checkRuleSave(repoRoot, name, readRuleFile(repoRoot, name).content)) out.push(...errs("rules", `content/rules/${i.file}`, [i]));
      }
      return out;
    }],
    ["gameplay", async () => {
      const snap = await readGameplay(repoRoot);
      const out: Problem[] = [];
      for (const t of GAMEPLAY_TABLES) for (const i of await checkGameplay(repoRoot, t, snap.tables[t])) out.push(...errs("gameplay", i.file, [i]));
      return out;
    }],
    ["scenes", () =>
      listScenes(repoRoot).flatMap((name) => {
        const file = `content/scenes/${name}.scene.json`;
        try {
          return errs("scenes", file, validateScene(readScene(repoRoot, name)));
        } catch (e) {
          return oneError("scenes", file, e);
        }
      }),
    ],
    ["modules", async () => {
      const r = await handleModulesRoute(repoRoot, "GET", "/api/editor/modules", undefined, { running: () => null, apply: () => Promise.resolve({}) });
      const b = r?.body as { problems?: Array<{ module: string; path: string; message: string }>; invalid?: Array<{ name: string; problems: Array<{ path: string; message: string }> }> };
      return [
        ...(b.problems ?? []).flatMap((p) => errs("modules", p.module, [p])),
        ...(b.invalid ?? []).flatMap((m) => errs("modules", m.name, m.problems)),
      ];
    }],
    ["story", async () => {
      const files = {} as StoryFiles;
      for (const f of STORY_FILES) files[f] = readStoryFile(repoRoot, f).content;
      return (await checkStory(repoRoot, files)).map((i) => ({ source: "story" as const, file: `content/quests/${i.file}.json`, severity: i.severity, message: at(i) }));
    }],
    ["build", () => {
      const dir = join(repoRoot, "content", "build", "profiles");
      return jsonFiles(dir).flatMap((f) => {
        try {
          loadProfile(readJson(join(dir, f)));
          return [];
        } catch (e) {
          return oneError("build", `content/build/profiles/${f}`, e);
        }
      });
    }],
    ["playtest", async () => {
      const dir = join(repoRoot, "content", "playtests");
      const files = jsonFiles(dir);
      if (files.length === 0) return [];
      const pkg = "@mmo-engine/playtest"; // looked up at run time: the editor does not depend on it
      const { loadScenario } = (await import(/* @vite-ignore */ pkg)) as { loadScenario: (json: unknown) => unknown };
      return files.flatMap((f) => {
        try {
          loadScenario(readJson(join(dir, f)));
          return [];
        } catch (e) {
          return oneError("playtest", `content/playtests/${f}`, e);
        }
      });
    }],
  ];
}

export async function collectProblems(repoRoot: string, collectors: Collector[] = problemCollectors(repoRoot)): Promise<Problem[]> {
  const out: Problem[] = [];
  for (const [source, run] of collectors) {
    try {
      out.push(...(await run()));
    } catch (e) {
      out.push({ source, file: source, severity: "warning", message: `validator could not run: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = `${p.source}|${p.file}|${p.message}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

export async function handleProblemsRoute(repoRoot: string, method: string, pathname: string): Promise<{ status: number; body: unknown } | null> {
  if (pathname !== "/api/editor/problems") return null;
  if (method !== "GET") return { status: 404, body: { ok: false, error: "not found" } };
  const problems = await collectProblems(repoRoot);
  return {
    status: 200,
    body: { ok: true, problems, errors: problems.filter((p) => p.severity === "error").length, warnings: problems.filter((p) => p.severity === "warning").length },
  };
}
