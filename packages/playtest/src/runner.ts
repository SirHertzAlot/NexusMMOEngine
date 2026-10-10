/**
 * The headless scenario runner: drives a SimWorld tick by tick with the
 * scenario's bots, records observations, evaluates assertions.
 *
 * No sockets, no rendering — the same systems the live server ticks.
 * Deterministic for a given seed (bots hash their randomness).
 */
import {
  BotSystem,
  SimWorld,
  Transform,
  IntentSystem,
  IntegrateSystem,
} from "@mmo-engine/engine-core";
import type { Scenario } from "./scenario.js";
import { evaluate, type Observations } from "./assertions.js";
import type { TracePoint } from "./replay.js";

export interface ScenarioResult {
  passed: boolean;
  failures: string[];
  ticks: number;
  /** Bot centroid after each tick run: what a replay is compared against. */
  trace: TracePoint[];
  /** The tick the run failed at: the error's tick, else the last tick run. */
  failTick: number;
}

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();

  const bots = new BotSystem({
    count: scenario.bots.count,
    home: scenario.bots.home,
    radius: scenario.bots.radius,
    catalog: null,
    seed: scenario.seed,
  });
  const systems = [bots, new IntentSystem(), new IntegrateSystem()];

  const errors: string[] = [];
  const moved = new Map<number, boolean>();
  const startPos = new Map<number, { x: number; z: number }>();

  const trace: TracePoint[] = [];
  let failTick = scenario.ticks;
  for (let tick = 1; tick <= scenario.ticks; tick++) {
    try {
      sim.beginTick(tick);
      for (const s of systems) s.step(sim, 1 / 30);
      sim.endTick();
    } catch (err) {
      errors.push(`tick ${tick}: ${err instanceof Error ? err.message : err}`);
      failTick = tick;
      break;
    }
    let sx = 0;
    let sz = 0;
    for (const e of bots.entities) {
      sx += Transform.px[e] ?? 0;
      sz += Transform.pz[e] ?? 0;
    }
    const n = Math.max(1, bots.entities.length);
    trace.push({ tick, x: sx / n, z: sz / n });
    for (const e of bots.entities) {
      if (!startPos.has(e)) {
        startPos.set(e, { x: Transform.px[e] ?? 0, z: Transform.pz[e] ?? 0 });
        moved.set(e, false);
      } else if (!moved.get(e)) {
        const s = startPos.get(e)!;
        const dx = (Transform.px[e] ?? 0) - s.x;
        const dz = (Transform.pz[e] ?? 0) - s.z;
        if (dx * dx + dz * dz > 0.01) moved.set(e, true);
      }
    }
  }

  const obs: Observations = {
    ticks: scenario.ticks,
    botCount: bots.entities.length,
    botMoved: moved,
    errors,
  };
  const failures = scenario.assertions
    .map((a) => evaluate(a, obs))
    .filter((m): m is string => m !== null);
  // An internal error fails the run even with no assertion covering it.
  if (errors.length > 0 && !scenario.assertions.some((a) => a.type === "noErrors")) {
    failures.push(`noErrors (implicit): ${errors[0]}`);
  }
  return { passed: failures.length === 0, failures, ticks: scenario.ticks, trace, failTick };
}
