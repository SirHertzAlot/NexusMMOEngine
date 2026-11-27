/**
 * Living Simulation System Test Suite:
 * Validates the 7 core living needs, allometric formulas (Kleiber's law, meal sizing,
 * post-meal digestion & bathroom breaks), world seasonal cycles (Spring awakening,
 * Autumn rutting/spurring, Winter dormancy/shelter), and CreatureSystem integration.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateWorldCycle, type SeasonClock } from "@mmo-engine/engine-core/dist/src/sim/world-cycle.js";
import { getSpeciesBioProfile } from "@mmo-engine/engine-core/dist/src/sim/species-metabolism.js";
import { LivingSimSystem } from "@mmo-engine/engine-core/dist/src/sim/living-sim-system.js";
import { CreatureSystem } from "@mmo-engine/engine-core/dist/src/creatures.js";
import { AnimationSystem } from "@mmo-engine/engine-core/dist/src/animation.js";
import { ResidentSystem, type ResidentTown } from "../src/index.js";
import { SimWorld } from "@mmo-engine/engine-core/dist/src/world.js";
import { loadGameRules } from "@mmo-engine/engine-core/dist/src/rules/boot.js";
import { CreaturesSchema } from "@mmo-engine/rules";
import { ClipId } from "@mmo-engine/protocol";
import * as C from "@mmo-engine/engine-core/dist/src/components.js";

const game = loadGameRules();

describe("Living Sim: World Seasonal & Climate Cycles", () => {
  const dayClock = { seconds: 100, offset: 0 };
  const seasonClock: SeasonClock = { daysPerSeason: 7, secondsPerDay: 100, offsetDay: 0 };
  const tickHz = 30;

  it("advances through Spring, Summer, Autumn, and Winter deterministically", () => {
    // Day 0: Spring start
    const spring = calculateWorldCycle(dayClock, seasonClock, 0, tickHz);
    assert.equal(spring.season, "spring");
    assert.equal(spring.year, 1);
    assert.ok(spring.springBreedingActive, "spring breeding active in early-to-mid spring");
    assert.ok(!spring.ungulateRutActive, "autumn rut not active in spring");

    // Day 7: Summer start (7 days * 100 s * 30 ticks = 21,000 ticks)
    const summer = calculateWorldCycle(dayClock, seasonClock, 7 * 100 * tickHz, tickHz);
    assert.equal(summer.season, "summer");
    assert.ok(summer.ambientTemperatureC > spring.ambientTemperatureC, "summer is warmer than spring");
    assert.equal(summer.dormancyFactor, 0.0, "summer dormancy is 0 (peak vitality)");

    // Day 14: Autumn start (14 days = Day 14) -> Autumn Rutting active
    const autumnMid = calculateWorldCycle(dayClock, seasonClock, 17 * 100 * tickHz, tickHz);
    assert.equal(autumnMid.season, "autumn");
    assert.ok(autumnMid.ungulateRutActive, "autumn rut / spurring season is active for deer/goats/boars");
    assert.ok(autumnMid.dormancyFactor > 0.15, "dormancy begins to rise in autumn");

    // Day 21: Winter start (21 days) -> Deep Dormancy
    const winterMid = calculateWorldCycle(dayClock, seasonClock, 24 * 100 * tickHz, tickHz);
    assert.equal(winterMid.season, "winter");
    assert.ok(winterMid.dormancyFactor >= 0.8, "winter dormancy factor peaks near 1.0");
    assert.ok(winterMid.ambientTemperatureC < 0, "winter ambient temperature drops below freezing");
    assert.ok(winterMid.forageAbundance < 0.5, "forage is scarce in winter");

    // Day 28: Completes 1 year, starts Year 2 Spring
    const year2 = calculateWorldCycle(dayClock, seasonClock, 28 * 100 * tickHz, tickHz);
    assert.equal(year2.season, "spring");
    assert.equal(year2.year, 2);
  });
});

describe("Living Sim: Species Biological Allometry & Kleiber's Law", () => {
  it("scales metabolic rate with body mass M^0.75 (Kleiber's law)", () => {
    const rabbit = getSpeciesBioProfile("rabbit"); // ~2.2 kg
    const wolf = getSpeciesBioProfile("wolf");     // ~45 kg
    const bear = getSpeciesBioProfile("bear");     // ~320 kg

    assert.ok(rabbit.bmrKcalPerDay > 0);
    assert.ok(wolf.bmrKcalPerDay > rabbit.bmrKcalPerDay);
    assert.ok(bear.bmrKcalPerDay > wolf.bmrKcalPerDay);

    // BMR per kg mass is much higher in small animals than large animals (Kleiber's allometry)
    const rabbitBmrPerKg = rabbit.bmrKcalPerDay / rabbit.adultMassKg;
    const bearBmrPerKg = bear.bmrKcalPerDay / bear.adultMassKg;
    assert.ok(rabbitBmrPerKg > bearBmrPerKg * 2.5, "small critters burn energy much faster per kg");
  });

  it("scales stomach capacity and feeding frequency appropriately", () => {
    const rabbit = getSpeciesBioProfile("rabbit");
    const deer = getSpeciesBioProfile("deer");
    const wolf = getSpeciesBioProfile("wolf");

    // Small critters feed more bouts per day; large herbivores feed 2-4 bouts; carnivores gorge
    assert.ok(rabbit.feedingBoutsPerDay >= 3, `rabbit feeds frequently (${rabbit.feedingBoutsPerDay} bouts/day)`);
    assert.ok(deer.feedingBoutsPerDay <= 4, `deer has measured crepuscular grazing bouts (${deer.feedingBoutsPerDay})`);
    assert.ok(wolf.feedingBoutsPerDay <= 3, `wolf has 1-2 major meal sessions (${wolf.feedingBoutsPerDay})`);

    // Stomach capacity is ~8% for herbivores, ~4.5% for carnivores
    assert.ok(deer.stomachCapacityKg > wolf.stomachCapacityKg, "herbivore rumen has larger volume than carnivore stomach");
  });

  it("predicts digestion transit delay before excretion peaks", () => {
    const rabbit = getSpeciesBioProfile("rabbit");
    const bear = getSpeciesBioProfile("bear");

    assert.ok(rabbit.digestionTransitHours < bear.digestionTransitHours, "smaller animals have faster gut transit times");
    assert.ok(rabbit.digestionTransitHours >= 1.5 && rabbit.digestionTransitHours <= 4.0);
    assert.ok(bear.digestionTransitHours >= 4.0 && bear.digestionTransitHours <= 8.0);
  });
});

describe("Living Sim: 7 Core Needs & Action State Machine", () => {
  const dayClock = { seconds: 120, offset: 0 }; // 120s day

  it("accumulates hunger and digests food, triggering post-meal bathroom break", () => {
    const sim = new LivingSimSystem({ dayClock, tickHz: 30 });
    const s = sim.getOrCreateState(1, "deer", 0, 0, 0);

    // Initial hunger accumulation
    s.hunger = 0.75;
    s.bathroom = 0.05;
    assert.equal(s.digestionFood, 0);

    // Feed creature
    sim.feed(1, 0.5);
    assert.equal(s.hunger, 0.25, "feeding drops hunger meter");
    assert.ok(s.digestionFood > 0, "food moves to digestion buffer");
    assert.ok(s.digestionTimerTicks > 0, "digestion timer begins counting down");

    // Advance time: fast-forward past digestion transit delay
    s.digestionTimerTicks = 1;
    // Step system with real world
    const world = new SimWorld();
    world.beginTick(30);
    sim.step(world, 1.0, true);

    // Bathroom urgency surges after digestion transit matures!
    assert.ok(s.bathroom >= 0.25, `bathroom urgency surges post-digestion (urgency: ${s.bathroom.toFixed(2)})`);

    // Relieve creature (bathroom break / territory scent mark)
    sim.relieve(1);
    assert.equal(s.bathroom, 0, "relieving empties bathroom urgency");
    assert.equal(s.digestionFood, 0, "digestion buffer is cleared");
  });

  it("accumulates thirst and hydrates at water", () => {
    const sim = new LivingSimSystem({ dayClock, tickHz: 30 });
    const s = sim.getOrCreateState(2, "wolf", 0, 0, 0);

    s.thirst = 0.8;
    sim.hydrate(2, 0.6);
    assert.ok(Math.abs(s.thirst - 0.2) < 1e-4, "hydration drops thirst meter");
    assert.ok(s.digestionWater > 0, "water enters fluid turnover buffer");
  });

  it("drives Autumn rutting and spurring displays during autumn mating season", () => {
    // Configure seasonClock to Autumn (Day 17)
    const seasonClock: SeasonClock = { daysPerSeason: 7, secondsPerDay: 100, offsetDay: 17 };
    const sim = new LivingSimSystem({ dayClock: { seconds: 100, offset: 0 }, seasonClock, tickHz: 30 });

    const deer = sim.getOrCreateState(3, "deer", 0, 0, 0);
    // Well-fed, hydrated, rested deer in Autumn
    deer.hunger = 0.1;
    deer.thirst = 0.1;
    deer.fatigue = 0.1;
    deer.bathroom = 0.0;

    // Step system with real world
    const world = new SimWorld();
    world.beginTick(30);
    sim.step(world, 1.0, true);

    // Breeding urge surges during Autumn rut
    assert.ok(deer.breeding > 0.5, `autumn rut triggers high breeding urge: ${deer.breeding}`);
    assert.equal(deer.action, "mating_display", "deer engages in mating/spurring display");
  });

  it("drives Winter denning / shelter requirement for hibernators", () => {
    // Configure seasonClock to Winter (Day 24)
    const seasonClock: SeasonClock = { daysPerSeason: 7, secondsPerDay: 100, offsetDay: 24 };
    const sim = new LivingSimSystem({ dayClock: { seconds: 100, offset: 0 }, seasonClock, tickHz: 30 });

    const bear = sim.getOrCreateState(4, "bear", 0, 0, 0);
    assert.ok(bear.profile.winterHibernator, "bear is a winter hibernator");

    // Step system with real world
    const world = new SimWorld();
    world.beginTick(30);
    sim.step(world, 1.0, true);

    // In deep winter, bear shelter urgency is maximum (denning) and action is sleeping/torpor
    assert.equal(bear.shelter, 1.0, "winter hibernator demands winter den shelter");
    assert.equal(bear.action, "sleeping", "hibernator enters prolonged winter torpor/sleep");
  });

  it("drives social play and entertainment when survival needs are met", () => {
    const seasonClock: SeasonClock = { daysPerSeason: 7, secondsPerDay: 100, offsetDay: 8 }; // Summer
    const sim = new LivingSimSystem({ dayClock: { seconds: 100, offset: 0 }, seasonClock, tickHz: 30 });

    const wolf = sim.getOrCreateState(5, "wolf", 0, 0, 0);
    wolf.hunger = 0.05;
    wolf.thirst = 0.05;
    wolf.fatigue = 0.1;
    wolf.bathroom = 0.0;
    wolf.entertainment = 0.8;

    const world = new SimWorld();
    world.beginTick(30);
    sim.step(world, 1.0, true);
    assert.equal(wolf.action, "entertaining", "wolf engages in pack play/grooming");
  });
});

describe("Living Sim: CreatureSystem Integration", () => {
  function setupCreatures(daySeconds = 120) {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const extra = CreaturesSchema.parse({
      creatures: {
        deer: {
          name: "Deer",
          health: 60,
          aggroRadius: 8,
          leashRadius: 60,
          respawnSeconds: 60,
          weapons: ["bite"],
          behavior: { temperament: "flee", noticeM: 1 },
        },
      },
    }).creatures;
    const creatures = {
      ...game.rules.creatures.creatures,
      ...extra,
    };
    const sys = new CreatureSystem({
      creatures,
      bases: game.rules.items.bases,
      dayClock: { seconds: daySeconds, offset: 0 },
      steer: false,
    });
    return { sim, sys };
  }

  it("provisions LivingSimState upon spawning creatures", () => {
    const { sim, sys } = setupCreatures();
    const [d] = sys.spawnPack(sim, "deer", 0, 0, [1, 1]);

    const state = sys.livingSim.getState(d);
    assert.ok(state !== undefined, "living sim state exists for spawned deer");
    assert.equal(state.kind, "deer");
    assert.equal(state.profile.diet, "herbivore");
    assert.equal(state.profile.matingSeason, "autumn_rut");
  });

  it("wakes sleeping creature immediately when attacked", () => {
    const { sim, sys } = setupCreatures();
    const [w] = sys.spawnPack(sim, "wolf", 0, 0, [1, 1]);

    const state = sys.livingSim.getState(w)!;
    // Force wolf to sleeping state
    state.action = "sleeping";
    state.fatigue = 0.8;

    // Simulate taking damage
    C.Health.current[w] = 50; // was 80
    sys.step(sim);

    assert.notEqual(state.action, "sleeping", "wolf woke up upon being hurt");
    assert.ok(state.fatigue <= 0.4, "fatigue suppressed by adrenaline upon waking");
  });

  it("pauses creature intent during bathroom relief and mating display", () => {
    const { sim, sys } = setupCreatures();
    const [d] = sys.spawnPack(sim, "deer", 0, 0, [1, 1]);
    const state = sys.livingSim.getState(d)!;

    // Set bathroom break active
    state.action = "bathroom";
    state.actionUntilTick = 90;

    sys.step(sim);

    // While relieving, movement intent is zeroed
    assert.equal(C.PlayerIntent.mx[d], 0);
    assert.equal(C.PlayerIntent.mz[d], 0);
    assert.equal(C.Animation.clipId[d], ClipId.Bathroom, "bathroom clipId replicated");
  });

  it("replicates living action ClipIds and preserves them in AnimationSystem when stationary", () => {
    const { sim, sys } = setupCreatures();
    const anim = new AnimationSystem();
    const [d] = sys.spawnPack(sim, "deer", 0, 0, [1, 1]);
    const state = sys.livingSim.getState(d)!;

    state.action = "mating_display";
    state.actionUntilTick = 120;
    sys.step(sim);
    assert.equal(C.Animation.clipId[d], ClipId.MatingDisplay);

    // AnimationSystem must preserve MatingDisplay while stationary
    anim.step(sim, 1 / 30);
    assert.equal(C.Animation.clipId[d], ClipId.MatingDisplay);

    // Transitioning back to wandering resets clipId to Idle
    state.action = "wandering";
    sys.step(sim);
    assert.equal(C.Animation.clipId[d], ClipId.Idle);
  });
});

describe("Living Sim: ResidentSystem & NPC Integration", () => {
  const dayClock = { seconds: 100, offset: 0 };
  const seasonClock: SeasonClock = { daysPerSeason: 7, secondsPerDay: 100, offsetDay: 0 };

  const testTown: ResidentTown = {
    id: "oakhaven",
    npcs: [
      { id: "innkeeper", home: "h1", role: "innkeeper", class: "peasant", cohort: "adult" },
      { id: "farmer", home: "h2", role: "farmer", class: "peasant", cohort: "adult" },
    ],
    positionOf: (anchor: string) => {
      if (anchor === "sq" || anchor === "@square") return { x: 0, z: 0 };
      if (anchor === "t1") return { x: 10, z: 10 };
      if (anchor === "h1") return { x: 20, z: 20 };
      if (anchor === "h2") return { x: 30, z: 30 };
      return undefined;
    },
  };

  it("provisions human bio profile for spawned residents", () => {
    const sim = new SimWorld();
    const livingSim = new LivingSimSystem({ dayClock, seasonClock, tickHz: 30 });
    const residents = new ResidentSystem({
      towns: [testTown],
      place: () => ({ anchor: "sq", outdoors: true, activity: "idle" }),
      catalog: null,
      livingSim,
    });

    residents.step(sim);
    const eid = residents.entityOf("innkeeper");
    assert.ok(eid !== undefined, "innkeeper entity spawned");

    const state = livingSim.getState(eid);
    assert.ok(state !== undefined, "living sim state created for resident");
    assert.equal(state.kind, "human");
    assert.equal(state.profile.diet, "omnivore");
    assert.equal(state.profile.chronotype, "diurnal");
    assert.equal(state.profile.adultMassKg, 75);
  });

  it("satisfies hunger/thirst and primes digestion during tavern activity", () => {
    const sim = new SimWorld();
    const livingSim = new LivingSimSystem({ dayClock, seasonClock, tickHz: 30 });
    let activity = "idle";
    const residents = new ResidentSystem({
      towns: [testTown],
      place: () => ({ anchor: "sq", outdoors: true, activity }),
      catalog: null,
      livingSim,
    });

    residents.step(sim);
    const eid = residents.entityOf("farmer")!;
    const state = livingSim.getState(eid)!;

    // Simulate hungry farmer
    state.hunger = 0.8;
    state.thirst = 0.7;
    state.entertainment = 0.2;

    // Shift to tavern visit
    activity = "tavern";
    residents.step(sim);

    assert.ok(state.hunger < 0.8, "tavern meal reduces hunger");
    assert.ok(state.thirst < 0.7, "tavern drink reduces thirst");
    assert.ok(state.entertainment > 0.2, "tavern socialization boosts entertainment");
    assert.ok(state.digestionFood > 0, "digestion buffer primed with meal");
  });

  it("relieves bathroom urgency when visiting latrines/privies", () => {
    const sim = new SimWorld();
    const livingSim = new LivingSimSystem({ dayClock, seasonClock, tickHz: 30 });
    const residents = new ResidentSystem({
      towns: [testTown],
      place: () => ({ anchor: "sq", outdoors: true, activity: "idle" }),
      catalog: null,
      livingSim,
    });

    residents.step(sim);
    const eid = residents.entityOf("farmer")!;
    const state = livingSim.getState(eid)!;

    // Excretion urgency peaks post-digestion
    state.bathroom = 0.95;
    residents.step(sim);

    // Resident automatically relieves and resets urgency
    assert.equal(state.bathroom, 0, "resident relieved bathroom urgency");
  });
});
