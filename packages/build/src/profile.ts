/**
 * EA19 build profiles: named pipelines (codegen, build, bakes, tests,
 * package). A profile is data (JSON), validated with zod; the default
 * profile covers the repo's standard pipeline.
 */
import { z } from "zod";

export const BuildStage = z.object({
  /** Stable id, also the cache key ("codegen", "build", ...). */
  id: z.string().min(1),
  /** Shell command run from the repo root, e.g. "npm run codegen". */
  command: z.string().min(1),
  /** Input files relative to the repo root; the stage is skipped when their hash is unchanged. */
  inputs: z.array(z.string().min(1)),
});

export type BuildStage = z.infer<typeof BuildStage>;

export const BuildProfile = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    stages: z.array(BuildStage).min(1),
  })
  .refine((p) => new Set(p.stages.map((s) => s.id)).size === p.stages.length, {
    message: "stage ids must be unique",
  });

export type BuildProfile = z.infer<typeof BuildProfile>;

/** Parse and validate a profile from JSON (throws on invalid). */
export function loadProfile(json: unknown): BuildProfile {
  return BuildProfile.parse(json);
}

/** The repo's standard pipeline. */
export function defaultProfile(): BuildProfile {
  return {
    name: "default",
    description: "codegen, build, bakes, tests, playtests, package",
    stages: [
      { id: "codegen", command: "npm run codegen", inputs: ["scripts/codegen.mjs"] },
      { id: "build", command: "npm run build", inputs: ["package.json"] },
      {
        id: "bake",
        command: "npm run bake:world && npm run dungeon:bake && npm run loot:bake",
        inputs: ["content/rules", "content/species"],
      },
      { id: "test", command: "npm test", inputs: ["package.json"] },
      {
        id: "playtest",
        command: "npm run playtest",
        inputs: ["content/playtests", "packages/playtest/src", "scripts/playtest.mjs"],
      },
      { id: "package", command: "npm run package", inputs: ["package.json"] },
    ],
  };
}
