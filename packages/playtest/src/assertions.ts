/**
 * Assertion evaluators: each checks one claim against the finished sim.
 * Pure functions of the recorded observations — no sim access, so they
 * stay testable without a world.
 */
import type { Assertion } from "./scenario.js";

export interface Observations {
  /** Ticks actually run. */
  ticks: number;
  /** Final bot entity count. */
  botCount: number;
  /** Whether each bot ever moved (entity id -> moved). */
  botMoved: Map<number, boolean>;
  /** Errors logged during the run. */
  errors: string[];
}

/** Evaluate one assertion; null when it passes, a message when it fails. */
export function evaluate(a: Assertion, obs: Observations): string | null {
  const label = a.label ?? a.type;
  switch (a.type) {
    case "botCount":
      return obs.botCount === a.equals
        ? null
        : `${label}: expected ${a.equals} bots, saw ${obs.botCount}`;
    case "allBotsMoved": {
      const stuck = [...obs.botMoved.entries()].filter(([, moved]) => !moved).map(([id]) => id);
      return stuck.length === 0 ? null : `${label}: bots never moved: ${stuck.join(", ")}`;
    }
    case "noErrors":
      return obs.errors.length === 0 ? null : `${label}: ${obs.errors.length} error(s): ${obs.errors[0]}`;
    case "tickReached":
      return obs.ticks >= a.tick ? null : `${label}: ran ${obs.ticks} ticks, needed ${a.tick}`;
  }
}
