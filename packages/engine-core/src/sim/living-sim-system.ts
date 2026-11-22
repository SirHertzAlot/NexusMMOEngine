/**
 * Living Simulation System: Biological Needs, Circadian Rhythms, and Seasonal Behavior Engine.
 *
 * Simulates the 7 core living needs:
 *  1. Eating (hunger, forage/hunt/graze, meal capacity & frequency via allometry)
 *  2. Drinking (thirst, hydration at water surfaces, water turnover)
 *  3. Sleeping (fatigue, circadian chronotype sleep windows, denning/torpor)
 *  4. Using the Bathroom (excretion/scent marking, triggered after digestion of food & water)
 *  5. Shelter (thermal protection, cave/burrow/house refuge from cold and storms)
 *  6. Breeding (seasonal rutting, spurring the ground, antler clashing, courtship)
 *  7. Entertainment (play-sparring, social grooming, curiosity, pack interaction)
 *
 * Complies with AGENTS.md §5 (Universal SI scale) and §6 (zero-allocation hot-path loop).
 */

import { defineQuery, hasComponent } from "bitecs";
import * as C from "../components.js";
import type { SimSystem } from "../systems.js";
import type { SystemAccess } from "../system-access.js";
import type { SimWorld } from "../world.js";
import { calculateWorldCycle, type SeasonClock, type WorldCycleState, DEFAULT_SEASON_CLOCK } from "./world-cycle.js";
import { getSpeciesBioProfile, type SpeciesBioProfile } from "./species-metabolism.js";
import type { DayClock } from "@mmo-engine/protocol";

export type LivingAction =
  | "idle"
  | "foraging"
  | "drinking"
  | "sleeping"
  | "bathroom"
  | "seeking_shelter"
  | "mating_display"
  | "entertaining"
  | "wandering";

export interface LivingSimState {
  readonly eid: number;
  readonly kind: string;
  readonly profile: SpeciesBioProfile;

  // Need Urgencies: 0.0 (fully satisfied / no urge) to 1.0 (desperate / urgent)
  hunger: number;
  thirst: number;
  fatigue: number;
  bathroom: number;
  shelter: number;
  breeding: number;
  entertainment: number;

  // Digestion state (bathroom breaks follow eating & drinking)
  digestionFood: number;
  digestionWater: number;
  digestionTimerTicks: number;

  // Current living activity
  action: LivingAction;
  actionUntilTick: number;
  actionX: number;
  actionZ: number;

  // Shelter anchor (burrow, cave, house, or home spawn)
  shelterX: number;
  shelterY: number;
  shelterZ: number;

  // Social / Mating partner
  partnerEid: number;

  // Last evaluation tick
  lastEvalTick: number;
}

export interface LivingSimOptions {
  dayClock?: DayClock;
  seasonClock?: SeasonClock;
  tickHz?: number;
  /** Function returning water surface height at (x, z), or null if dry land. */
  waterSurfaceAt?: (x: number, z: number) => number | null;
  /** Function returning ground height at (x, z). */
  groundHeightAt?: (x: number, z: number) => number;
}

export class LivingSimSystem implements SimSystem {
  readonly name = "living_sim";
  readonly access: SystemAccess = {
    system: "living_sim",
    reads: [
      { component: "Health", fields: ["current"] },
      "Transform",
    ],
    writes: [],
  };
  private readonly states = new Map<number, LivingSimState>();
  private readonly movers = defineQuery([C.Transform, C.Health]);
  private tickHz: number;
  private opts: LivingSimOptions;
  private currentCycle: WorldCycleState;
  private lastStepTick = -1;

  constructor(opts: LivingSimOptions = {}) {
    this.opts = opts;
    this.tickHz = opts.tickHz ?? 30;
    this.currentCycle = calculateWorldCycle(opts.dayClock, opts.seasonClock ?? DEFAULT_SEASON_CLOCK, 0, this.tickHz);
  }

  /** Gets the current macro seasonal and environmental world cycle. */
  get worldCycle(): WorldCycleState {
    return this.currentCycle;
  }

  /** Registers or gets an existing LivingSimState for an entity. */
  getOrCreateState(eid: number, kind: string, homeX = 0, homeY = 0, homeZ = 0): LivingSimState {
    let state = this.states.get(eid);
    if (!state) {
      const profile = getSpeciesBioProfile(kind);
      // Stagger initial need values with deterministic pseudo-random offsets
      const seed = (eid * 2654435761) >>> 0;
      const r0 = ((seed & 0xff) / 255);
      const r1 = (((seed >> 8) & 0xff) / 255);
      const r2 = (((seed >> 16) & 0xff) / 255);

      state = {
        eid,
        kind,
        profile,
        hunger: 0.2 + 0.3 * r0,
        thirst: 0.2 + 0.3 * r1,
        fatigue: 0.1 + 0.3 * r2,
        bathroom: 0.05 + 0.2 * r0,
        shelter: 0.0,
        breeding: 0.0,
        entertainment: 0.2 + 0.4 * r1,
        digestionFood: 0,
        digestionWater: 0,
        digestionTimerTicks: 0,
        action: "idle",
        actionUntilTick: 0,
        actionX: homeX,
        actionZ: homeZ,
        shelterX: homeX,
        shelterY: homeY,
        shelterZ: homeZ,
        partnerEid: -1,
        lastEvalTick: 0,
      };
      this.states.set(eid, state);
    }
    return state;
  }

  getState(eid: number): LivingSimState | undefined {
    return this.states.get(eid);
  }

  remove(eid: number): boolean {
    return this.states.delete(eid);
  }

  /** Feed food to an entity (satisfies hunger, starts digestion transit toward bathroom break). */
  feed(eid: number, amount = 0.5): void {
    const s = this.states.get(eid);
    if (!s) return;
    s.hunger = Math.max(0, s.hunger - amount);
    s.digestionFood += amount;
    // Prime digestion transit: bathroom urgency will rise after transit delay
    const transitSeconds = (s.profile.digestionTransitHours / 24) * (this.opts.dayClock?.seconds ?? 2400);
    s.digestionTimerTicks = Math.round(transitSeconds * this.tickHz);
  }

  /** Hydrate an entity with water (satisfies thirst, contributes to fluid excretion). */
  hydrate(eid: number, amount = 0.6): void {
    const s = this.states.get(eid);
    if (!s) return;
    s.thirst = Math.max(0, s.thirst - amount);
    s.digestionWater += amount;
    const transitSeconds = (s.profile.digestionTransitHours * 0.6 / 24) * (this.opts.dayClock?.seconds ?? 2400);
    s.digestionTimerTicks = Math.min(
      s.digestionTimerTicks > 0 ? s.digestionTimerTicks : 999999,
      Math.round(transitSeconds * this.tickHz),
    );
  }

  /** Relieve bathroom / mark territory (empties bathroom meter and digestion buffers). */
  relieve(eid: number): void {
    const s = this.states.get(eid);
    if (!s) return;
    s.bathroom = 0;
    s.digestionFood = 0;
    s.digestionWater = 0;
    s.digestionTimerTicks = 0;
  }

  /** Put entity to sleep (replenishes fatigue). */
  sleep(eid: number, durationTicks: number): void {
    const s = this.states.get(eid);
    if (!s) return;
    s.action = "sleeping";
    s.actionUntilTick = s.lastEvalTick + durationTicks;
  }

  step(sim: SimWorld, dtSeconds: number, forceAll = false): void {
    const tick = sim.currentTick;
    if (tick === this.lastStepTick && !forceAll) return;
    this.lastStepTick = tick;

    this.currentCycle = calculateWorldCycle(
      this.opts.dayClock,
      this.opts.seasonClock ?? DEFAULT_SEASON_CLOCK,
      tick,
      this.tickHz,
    );

    const secPerDay = this.opts.dayClock?.seconds ?? 2400;
    const dtGameHours = (dtSeconds / secPerDay) * 24;

    // Evaluate living entities in staggered round-robin (every entity updates once per second)
    const evalCadence = Math.max(1, this.tickHz);

    for (const [eid, s] of this.states) {
      if (sim?.ecs && hasComponent(sim.ecs, C.Health, eid) && C.Health.current[eid] <= 0) {
        continue;
      }

      // Check if entity is due for needs update (or forced for tests/initialization)
      if (forceAll || (tick + eid) % evalCadence === 0) {
        this.updateEntityNeeds(eid, s, dtGameHours * (evalCadence / this.tickHz), tick);
      }

      // Progress active living action
      this.progressEntityAction(sim, eid, s, tick);
    }
  }

  private updateEntityNeeds(eid: number, s: LivingSimState, dtHours: number, tick: number): void {
    s.lastEvalTick = tick;
    const p = s.profile;
    const cycle = this.currentCycle;

    // 1. Hunger Accumulation:
    // Rate scales with BMR, winter hyperphagia in Autumn, and dormancy reduction in Winter
    let hungerRate = (p.feedingBoutsPerDay / 24) * dtHours;
    if (cycle.season === "autumn") {
      hungerRate *= 1.4; // Autumn hyperphagia: eat heavily to store fat
    } else if (cycle.season === "winter" && p.winterHibernator) {
      hungerRate *= 0.15; // Hibernating / torpid in winter
    }
    s.hunger = Math.min(1.0, s.hunger + hungerRate);

    // 2. Thirst Accumulation:
    // Rate scaled by ambient temperature & seasonal hydration multiplier
    let thirstRate = (p.drinkingBoutsPerDay / 24) * dtHours * cycle.hydrationRateMultiplier;
    if (cycle.season === "winter" && p.winterHibernator) {
      thirstRate *= 0.15;
    }
    s.thirst = Math.min(1.0, s.thirst + thirstRate);

    // 3. Fatigue / Sleepiness Accumulation:
    if (s.action === "sleeping") {
      // Rapid replenishment while sleeping
      s.fatigue = Math.max(0.0, s.fatigue - (1.0 / p.sleepHoursPerDay) * dtHours);
    } else {
      const wakingHours = Math.max(4, 24 - p.sleepHoursPerDay);
      s.fatigue = Math.min(1.0, s.fatigue + (1.0 / wakingHours) * dtHours);
    }

    // 4. Digestion & Bathroom Transit Delay:
    // Bathroom urgency rises following eating and drinking once digestion delay matures!
    if (s.digestionTimerTicks > 0) {
      s.digestionTimerTicks -= Math.round(dtHours * (this.opts.dayClock?.seconds ?? 2400) * this.tickHz / 24);
      if (s.digestionTimerTicks <= 0) {
        s.digestionTimerTicks = 0;
        // Transit reached bowel/bladder: bathroom urgency spikes!
        s.bathroom = Math.min(1.0, s.bathroom + 0.45 * s.digestionFood + 0.45 * s.digestionWater);
      }
    } else if (s.digestionFood > 0 || s.digestionWater > 0) {
      s.bathroom = Math.min(1.0, s.bathroom + 0.15 * dtHours);
    }

    // 5. Shelter Need:
    // Driven by freezing winter cold, storms, or nocturnal vulnerability
    let shelterUrge = 0.0;
    if (cycle.ambientTemperatureC < 0) {
      shelterUrge += Math.min(1.0, Math.abs(cycle.ambientTemperatureC) / 10.0) * p.shelterReliance * 0.4;
    }
    if (cycle.season === "winter" && p.winterHibernator) {
      shelterUrge = 1.0; // Hibernators desperately demand winter den shelter
    }
    s.shelter = Math.min(1.0, shelterUrge);

    // 6. Breeding / Mating Urge:
    // Driven by species mating calendar (Autumn Rut for ungulates/caprines, Spring for birds/wolves)
    let breedingUrge = 0.0;
    const isMatingSeason = (p.matingSeason === "autumn_rut" && cycle.ungulateRutActive) ||
      (p.matingSeason === "spring_breeding" && cycle.springBreedingActive) ||
      (p.matingSeason === "year_round");

    if (isMatingSeason && s.hunger < 0.5 && s.thirst < 0.5 && s.fatigue < 0.6) {
      // Well-nourished animals in season experience strong courtship / spurring urge
      breedingUrge = 0.6 + 0.4 * Math.sin(cycle.seasonProgress * Math.PI);
    }
    s.breeding = breedingUrge;

    // 7. Entertainment / Social Play:
    // Animals get bored or seek play/grooming when basic survival needs are satisfied
    if (s.hunger < 0.4 && s.thirst < 0.4 && s.fatigue < 0.5 && s.bathroom < 0.5) {
      s.entertainment = Math.min(1.0, s.entertainment + (0.08 * p.socialPlayWeight) * dtHours);
    } else {
      s.entertainment = Math.max(0.0, s.entertainment - 0.1 * dtHours);
    }

    // Select next high-level autonomous action if not currently committed
    if (tick >= s.actionUntilTick) {
      this.decideLivingAction(eid, s, cycle);
    }
  }

  private decideLivingAction(eid: number, s: LivingSimState, cycle: WorldCycleState): void {
    const p = s.profile;
    const hour = cycle.timeOfDay * 24;

    // Check Chronotype Sleep Window:
    const inSleepWindow = p.sleepWindowHours[0] <= p.sleepWindowHours[1]
      ? hour >= p.sleepWindowHours[0] && hour < p.sleepWindowHours[1]
      : hour >= p.sleepWindowHours[0] || hour < p.sleepWindowHours[1];

    // 1. Winter Hibernation (Supreme priority for hibernators in Winter):
    if (cycle.season === "winter" && p.winterHibernator) {
      s.action = "sleeping";
      s.actionUntilTick = s.lastEvalTick + 60 * this.tickHz; // 60s sleep block
      return;
    }

    // 2. Bathroom Break: Immediate relief needed after digestion!
    if (s.bathroom >= 0.7) {
      s.action = "bathroom";
      // Pause for a brief 3.5s bathroom break / territory scent mark
      s.actionUntilTick = s.lastEvalTick + Math.round(3.5 * this.tickHz);
      return;
    }

    // 3. Critical Thirst: Seek drinking water
    if (s.thirst >= 0.65) {
      s.action = "drinking";
      s.actionUntilTick = s.lastEvalTick + Math.round(5.0 * this.tickHz);
      return;
    }

    // 4. Critical Hunger: Foraging / Grazing / Hunting
    if (s.hunger >= 0.60) {
      s.action = "foraging";
      // Grazing / foraging bout (6-12s)
      s.actionUntilTick = s.lastEvalTick + Math.round(8.0 * this.tickHz);
      return;
    }

    // 5. Sleep / Rest: Exhaustion or natural sleep window
    if (s.fatigue >= 0.75 || (inSleepWindow && s.fatigue >= 0.4)) {
      s.action = "sleeping";
      s.actionUntilTick = s.lastEvalTick + Math.round(15.0 * this.tickHz);
      return;
    }

    // 6. Seeking Shelter from Freezing Cold or Night
    if (s.shelter >= 0.7) {
      s.action = "seeking_shelter";
      s.actionUntilTick = s.lastEvalTick + Math.round(8.0 * this.tickHz);
      return;
    }

    // 7. Mating Display / Spurring / Rutting Sparring:
    if (s.breeding >= 0.65) {
      s.action = "mating_display";
      // Spurring the dirt, strutting, sparring headbutt
      s.actionUntilTick = s.lastEvalTick + Math.round(6.0 * this.tickHz);
      return;
    }

    // 8. Social Play / Grooming / Entertainment:
    if (s.entertainment >= 0.65) {
      s.action = "entertaining";
      s.actionUntilTick = s.lastEvalTick + Math.round(5.0 * this.tickHz);
      return;
    }

    // 9. Default: Casual Wandering & Grazing
    s.action = "wandering";
    s.actionUntilTick = s.lastEvalTick + Math.round(6.0 * this.tickHz);
  }

  private progressEntityAction(sim: SimWorld, eid: number, s: LivingSimState, tick: number): void {
    // Action execution effects:
    switch (s.action) {
      case "bathroom":
        if (tick >= s.actionUntilTick) {
          // Relieved!
          this.relieve(eid);
          s.action = "idle";
        }
        break;

      case "foraging":
        if (tick >= s.actionUntilTick) {
          // Finished eating meal
          const mealAmount = s.profile.diet === "herbivore" ? 0.35 : 0.65;
          this.feed(eid, mealAmount);
          s.action = "idle";
        }
        break;

      case "drinking":
        if (tick >= s.actionUntilTick) {
          // Finished drinking
          this.hydrate(eid, 0.55);
          s.action = "idle";
        }
        break;

      case "sleeping":
        if (s.fatigue <= 0.05 || tick >= s.actionUntilTick) {
          if (s.fatigue <= 0.1) s.action = "idle";
        }
        break;

      case "mating_display":
        if (tick >= s.actionUntilTick) {
          // Satisfied breeding display urge for this bout
          s.breeding = Math.max(0.1, s.breeding - 0.4);
          s.entertainment = Math.max(0, s.entertainment - 0.3);
          s.action = "idle";
        }
        break;

      case "entertaining":
        if (tick >= s.actionUntilTick) {
          s.entertainment = 0.1;
          s.action = "idle";
        }
        break;

      default:
        break;
    }
  }
}
