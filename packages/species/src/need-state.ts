/**
 * NeedState evaluation: per-entity runtime state, evaluated in batches off
 * the tick. Cadence per the draft (B4): instinct 1Hz, social 0.2Hz,
 * strategic on-demand. Levels decay per NeedDef.decayPerHour and recover
 * where the entity's location satisfies the need. Nothing here runs in the
 * 30Hz tick; the batch runner is called from the sim/edge side.
 *
 * The store is a narrow interface so the backing is swappable; the runner
 * holds no game state beyond last-evaluation timestamps.
 */

import { needSatisfaction } from "./suitability.js";
import type { ConditionFields, NeedCatalog, NeedState, SpeciesNeeds, Vec2 } from "./needs.js";

/** Which thinking cadence + action-space an entity gets; absent = no thinking. */
export type ThinkTier = "instinct" | "social" | "strategic";

/** Evaluations per second per tier. 0 = on-demand only (strategic). */
export const NEED_EVAL_CADENCE_HZ: Record<ThinkTier, number> = {
  instinct: 1,
  social: 0.2,
  strategic: 0,
};

/** How fast a satisfied need refills per sim-hour at full satisfaction. A code constant, documented, tunable later. */
export const RECOVERY_PER_HOUR = 1.0;

/** A need counts as "being met" at this satisfaction or above; below it, the level decays. */
const RECOVERY_FLOOR = 0.5;

export interface NeedStateStore {
  get(entityId: number): NeedState | undefined;
  set(state: NeedState): void;
}

/** The default in-memory store. Swap behind the interface for a persisted one. */
export class MapNeedStateStore implements NeedStateStore {
  private readonly states = new Map<number, NeedState>();
  get(entityId: number): NeedState | undefined {
    return this.states.get(entityId);
  }
  set(state: NeedState): void {
    this.states.set(state.entityId, state);
  }
}

export interface NeedEvalContext {
  store: NeedStateStore;
  catalog: NeedCatalog;
  speciesOf: (entityId: number) => SpeciesNeeds | undefined;
  tierOf: (entityId: number) => ThinkTier;
  posOf: (entityId: number) => Vec2;
  /** The habitat systems' condition fields at a position. */
  fieldsAt: (pos: Vec2) => ConditionFields;
  nowMs: () => number;
  tick: () => number;
}

/**
 * One entity's level update. Pure: does not mutate the input state.
 * Levels decay by decayPerHour * dt when the need is unmet, and refill
 * toward 1 where the location satisfies the need. Unknown needs in the
 * state are left alone; unseen catalog needs start full.
 */
export function updateNeedLevels(
  catalog: NeedCatalog,
  species: SpeciesNeeds,
  state: NeedState,
  fields: ConditionFields,
  dtHours: number,
  tick: number,
): NeedState {
  const levels: Record<string, number> = { ...state.levels };
  for (const [needId] of Object.entries(species.needs)) {
    const need = catalog.byId.get(needId);
    if (!need) throw new Error(`updateNeedLevels: unknown need id ${needId}`);
    const sat = needSatisfaction(need, fields);
    const level = levels[needId] ?? 1;
    levels[needId] =
      sat >= RECOVERY_FLOOR
        ? Math.min(1, level + sat * RECOVERY_PER_HOUR * dtHours)
        : Math.max(0, level - need.decayPerHour * dtHours);
  }
  return { entityId: state.entityId, levels, updatedTick: tick };
}

export interface NeedBatchResult {
  evaluated: number;
  skipped: number;
}

/**
 * Runs one off-tick evaluation batch. Entities whose tier cadence has not
 * elapsed are skipped; strategic-tier entities run only when forced.
 * The runner never touches the tick — the caller (sim/edge side) owns
 * when batches run.
 */
export class NeedBatchRunner {
  private readonly lastEvalMs = new Map<number, number>();

  run(ctx: NeedEvalContext, entityIds: number[], opts?: { force?: boolean }): NeedBatchResult {
    let evaluated = 0;
    let skipped = 0;
    const now = ctx.nowMs();
    for (const entityId of entityIds) {
      const tier = ctx.tierOf(entityId);
      const hz = NEED_EVAL_CADENCE_HZ[tier];
      const last = this.lastEvalMs.get(entityId);
      const due = opts?.force === true || (hz > 0 && (last === undefined || now - last >= 1000 / hz));
      if (!due) {
        skipped++;
        continue;
      }
      const species = ctx.speciesOf(entityId);
      if (!species) {
        skipped++;
        continue;
      }
      const prev = ctx.store.get(entityId);
      const state: NeedState = prev ?? { entityId, levels: {}, updatedTick: ctx.tick() };
      const dtHours = last === undefined ? 0 : Math.max(0, (now - last) / 3_600_000);
      const next = updateNeedLevels(ctx.catalog, species, state, ctx.fieldsAt(ctx.posOf(entityId)), dtHours, ctx.tick());
      ctx.store.set(next);
      this.lastEvalMs.set(entityId, now);
      evaluated++;
    }
    return { evaluated, skipped };
  }
}
