/**
 * The editor's Problems list: every validator the host already runs on a save,
 * run over what is on disk now, as one flat list.
 *
 *   GET /api/editor/problems → { ok, problems: Problem[], errors, warnings }
 *
 * Read-only. A validator that cannot run (a package not built) shows up as one
 * warning for its source instead of failing the whole list.
 */
import { MEDIA_DOCS, MEDIA_DOC_NAMES, crossCheck } from "@mmo-engine/art";
import { validateHud, validateFlow, validateScene, validateStrings } from "@mmo-engine/scene";
import { handleFlowRoute } from "./flow-host.js";
import { handleUiRoute } from "./ui-host.js";
import { readMedia } from "./media-host.js";
import { checkGameplay, readGameplay } from "./gameplay-host.js";
import { GAMEPLAY_TABLES } from "./gameplay-tables.js";
import { checkRuleSave, readRuleFile, ruleFileNames } from "./rules-host.js";
import { listScenes, readScene } from "./scenes-host.js";
import { handleModulesRoute } from "./modules-host.js";
import { STORY_FILES, type StoryFiles } from "./story-validate.js";
import { checkStory, readStoryFile } from "./story-host.js";
import { listProfiles } from "./release-host.js";
import { handlePlaytestRoute } from "./playtest-host.js";
import { validatePlaytest } from "./playtest-model.js";

export type ProblemSource = "flow" | "hud" | "strings" | "media" | "gameplay" | "rules" | "scenes" | "modules" | "story" | "build" | "playtest";
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
const warn = (source: ProblemSource, file: string, message: string): Problem => ({ source, file, severity: "warning", message });

type Collector = [ProblemSource, () => Problem[] | Promise<Problem[]>];

export async function collectProblems(repoRoot: string, dataDir: string): Promise<Problem[]> {
  const collectors: Collector[] = [
    ["flow", () => {
      const r = handleFlowRoute(repoRoot, "GET", "/api/editor/flow", undefined);
      if (!r || r.status !== 200) return []; // no flow file: the client falls back to its built-in flow
      const b = r.body as { content: unknown; scenes: string[] };
      return errs("flow", "content/flow/game.flow.json", validateFlow(b.content, { scenes: b.scenes }));
    }],
    ["hud", () => {
      const r = handleUiRoute(repoRoot, "GET", "/api/editor/hud", undefined);
      return r?.status === 200 ? errs("hud", "content/ui/hud.json", validateHud((r.body as { content: unknown }).content)) : [];
    }],
    ["strings", () => {
      const r = handleUiRoute(repoRoot, "GET", "/api/editor/strings", undefined);
      if (!r) return [];
      if (r.status !== 200) return [warn("strings", "content/strings/en.json", (r.body as { error: string }).error)];
      const b = r.body as {
        langs: Record<string, unknown>;
        status: Record<string, { counts: Record<string, number> }>;
        missingInSource: string[];
      };
      const out: Problem[] = [];
      for (const [lang, bundle] of Object.entries(b.langs)) {
        const file = `content/strings/${lang}.json`;
        out.push(...errs("strings", file, validateStrings(bundle, lang)));
        const c = b.status[lang]?.counts;
        if (lang !== "en" && c) {
          const bad = (["missing", "mismatch", "stale"] as const).filter((k) => c[k] > 0).map((k) => `${c[k]} ${k}`);
          if (bad.length) out.push(warn("strings", file, `translation out of step with English: ${bad.join(", ")}`));
        }
      }
      for (const id of b.missingInSource) out.push({ source: "strings", file: "content/strings/en.json", severity: "error", message: `the client asks for "${id}" and English has no such string` });
      return out;
    }],
    ["media", () => {
      const out: Problem[] = [];
      const content = readMedia(repoRoot);
      for (const name of MEDIA_DOC_NAMES) {
        const doc = (content as Record<string, unknown>)[name];
        if (doc !== undefined) out.push(...errs("media", `content/${MEDIA_DOCS[name].file}`, MEDIA_DOCS[name].validate(doc)));
      }
      out.push(...errs("media", "content (media cross-check)", crossCheck(content)));
      return out;
    }],
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
          return errs("scenes", file, [{ message: e instanceof Error ? e.message : String(e) }]);
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
    ["build", () =>
      listProfiles(repoRoot).flatMap((p) => p.issues.map((m): Problem => ({ source: "build", file: `content/build/${p.name}.json`, severity: "error", message: m }))),
    ],
    ["playtest", async () => {
      const r = await handlePlaytestRoute(repoRoot, dataDir, "GET", "/api/editor/playtests", undefined, () => Promise.reject(new Error("read only")));
      const scenarios = (r?.body as { scenarios?: Array<{ name: string; content: unknown; history: Array<{ ok: boolean; error?: string; results: Array<{ ok: boolean; label: string; actual: string }> }> }> }).scenarios ?? [];
      return scenarios.flatMap((s) => {
        const file = `content/playtests/${s.name}.playtest.json`;
        const out = errs("playtest", file, validatePlaytest(s.content, s.name));
        const last = s.history[0];
        // history is newest first: a failed run stays a problem until a later one passes.
        if (last && !last.ok) {
          const why = last.error ?? last.results.filter((x) => !x.ok).map((x) => `${x.label} (${x.actual})`).join(", ");
          out.push({ source: "playtest", file, severity: "error", message: `last run failed: ${why || "no detail"}` });
        }
        return out;
      });
    }],
  ];
  const out: Problem[] = [];
  for (const [source, run] of collectors) {
    try {
      out.push(...(await run()));
    } catch (e) {
      out.push(warn(source, source, `validator could not run: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = `${p.source}|${p.file}|${p.message}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

export async function handleProblemsRoute(
  repoRoot: string,
  dataDir: string,
  method: string,
  pathname: string,
): Promise<{ status: number; body: unknown } | null> {
  if (pathname !== "/api/editor/problems") return null;
  if (method !== "GET") return { status: 404, body: { ok: false, error: "not found" } };
  const problems = await collectProblems(repoRoot, dataDir);
  return {
    status: 200,
    body: { ok: true, problems, errors: problems.filter((p) => p.severity === "error").length, warnings: problems.filter((p) => p.severity === "warning").length },
  };
}

