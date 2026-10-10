/**
 * EA26 scenario documents: seed + ticks + bots + assertions, validated
 * with zod. Scenarios live in `content/playtests/*.json`.
 */
import { z } from "zod";

export const BotSpec = z.object({
  count: z.number().int().min(1).max(64),
  home: z.object({ x: z.number(), z: z.number() }),
  radius: z.number().min(0),
});

const AssertionBase = z.object({
  /** Human-readable label for the report. */
  label: z.string().optional(),
});

export const Assertion = z.discriminatedUnion("type", [
  AssertionBase.extend({ type: z.literal("botCount"), equals: z.number().int().min(0) }),
  AssertionBase.extend({ type: z.literal("allBotsMoved") }),
  AssertionBase.extend({ type: z.literal("noErrors") }),
  AssertionBase.extend({ type: z.literal("tickReached"), tick: z.number().int().min(1) }),
]);

export type Assertion = z.infer<typeof Assertion>;

export const Scenario = z.object({
  name: z.string().min(1),
  /** Deterministic seed; a fixed default keeps ad-hoc scenarios reproducible. */
  seed: z.number().int().default(1337),
  ticks: z.number().int().min(1).max(30 * 60 * 10),
  bots: BotSpec,
  assertions: z.array(Assertion).min(1, "a scenario with no assertions proves nothing"),
});

export type Scenario = z.infer<typeof Scenario>;

/** Parse and validate a scenario from JSON (throws on invalid). */
export function loadScenario(json: unknown): Scenario {
  const result = Scenario.safeParse(json);
  if (!result.success) {
    // Surface the unknown-assertion case with a clear message.
    for (const issue of result.error.issues) {
      if (issue.code === "invalid_union") {
        throw new Error(`unknown assertion type in scenario`);
      }
    }
    throw result.error;
  }
  return result.data;
}
