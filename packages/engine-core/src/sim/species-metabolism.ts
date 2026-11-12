/**
 * Species Allometric Metabolic & Biological Need Profiles.
 *
 * Grounded in empirical zoological allometry and freely available bioenergetic data:
 *  - Kleiber's Law: Basal Metabolic Rate BMR = c * M^0.75 (where M is adult mass in kg).
 *  - Stomach Capacity: C_stomach = k_diet * M^1.0 (~8% body mass for ruminant/hindgut herbivores,
 *    ~4.5% for carnivores/omnivores).
 *  - Meal Frequency: Bouts/Day = k_freq * M^-0.25 (smaller critters eat frequently in small bouts;
 *    large herbivores graze 3-4 distinct crepuscular bouts; carnivores gorge 1-2 large meals or fast).
 *  - Water Turnover: Hydration requirement W_liters/day = 0.15 * M^0.80.
 *  - Digestion Transit Delay: Bathroom breaks follow eating and drinking after a species-specific transit delay.
 *  - Circadian Chronotypes: Diurnal, Nocturnal, Crepuscular, Cathemeral.
 *  - Seasonal Adaptations: Autumn hyperphagia & rutting, Winter torpor/hibernation.
 */

import { SPECIES_NATURAL_SCALE } from "../creatures.js";

export type DietType = "herbivore" | "carnivore" | "omnivore";
export type Chronotype = "diurnal" | "nocturnal" | "crepuscular" | "cathemeral";
export type MatingSeasonKind = "autumn_rut" | "spring_breeding" | "summer_estrus" | "year_round";

export interface SpeciesBioProfile {
  speciesId: string;
  diet: DietType;
  chronotype: Chronotype;
  /** Adult reference mass in kilograms. */
  adultMassKg: number;
  /** Basal Metabolic Rate (kcal equivalent / sim-day). Kleiber's Law: 70 * M^0.75. */
  bmrKcalPerDay: number;
  /** Stomach capacity (kg food equivalent). C_stomach = k_diet * M^1.0. */
  stomachCapacityKg: number;
  /** Natural feeding bouts per day (eating frequency). */
  feedingBoutsPerDay: number;
  /** Digestion transit delay (game hours) before excretion urge peaks after eating/drinking. */
  digestionTransitHours: number;
  /** Daily water requirement (liters / sim-day). W = 0.15 * M^0.80. */
  waterTurnoverLitersPerDay: number;
  /** Drinking bouts per day. */
  drinkingBoutsPerDay: number;
  /** Required sleep hours per day. */
  sleepHoursPerDay: number;
  /** Preferred sleep window [startHour, endHour] (0..24). */
  sleepWindowHours: [number, number];
  /** Whether the species enters deep winter hibernation/torpor (e.g. bears, hedgehogs). */
  winterHibernator: boolean;
  /** Seasonal mating schedule. */
  matingSeason: MatingSeasonKind;
  /** Sociability / entertainment need weight (1.0 = normal, 1.8 = playful social pack). */
  socialPlayWeight: number;
  /** Shelter reliance (1.0 = open wanderer, 2.5 = den/burrow nester). */
  shelterReliance: number;
}

/** Authoritative zoological baseline masses and biological archetypes. */
const SPECIES_BASE_DATA: Record<string, {
  diet: DietType;
  chronotype: Chronotype;
  massKg: number;
  sleepHours: number;
  sleepWindow: [number, number];
  winterHibernator?: boolean;
  matingSeason?: MatingSeasonKind;
  socialPlayWeight?: number;
  shelterReliance?: number;
}> = {
  // Ungulates / Ruminants / Large Herbivores (Autumn Rut, Crepuscular/Diurnal)
  deer: {
    diet: "herbivore",
    chronotype: "crepuscular",
    massKg: 130,
    sleepHours: 5.5,
    sleepWindow: [11, 15], // Mid-day bedded rest
    matingSeason: "autumn_rut",
    socialPlayWeight: 1.2,
    shelterReliance: 1.1,
  },
  stag: {
    diet: "herbivore",
    chronotype: "crepuscular",
    massKg: 200,
    sleepHours: 5.0,
    sleepWindow: [11, 15],
    matingSeason: "autumn_rut",
    socialPlayWeight: 1.3,
    shelterReliance: 1.1,
  },
  elk: {
    diet: "herbivore",
    chronotype: "crepuscular",
    massKg: 280,
    sleepHours: 5.2,
    sleepWindow: [11, 15],
    matingSeason: "autumn_rut",
    socialPlayWeight: 1.2,
    shelterReliance: 1.1,
  },
  bighorn: {
    diet: "herbivore",
    chronotype: "diurnal",
    massKg: 85,
    sleepHours: 6.0,
    sleepWindow: [22, 4],
    matingSeason: "autumn_rut",
    socialPlayWeight: 1.4,
    shelterReliance: 1.3,
  },
  goat: {
    diet: "herbivore",
    chronotype: "diurnal",
    massKg: 70,
    sleepHours: 6.5,
    sleepWindow: [22, 4.5],
    matingSeason: "autumn_rut",
    socialPlayWeight: 1.5,
    shelterReliance: 1.4,
  },
  sheep: {
    diet: "herbivore",
    chronotype: "diurnal",
    massKg: 80,
    sleepHours: 7.0,
    sleepWindow: [21, 4],
    matingSeason: "autumn_rut",
    socialPlayWeight: 1.3,
    shelterReliance: 1.3,
  },
  cow: {
    diet: "herbivore",
    chronotype: "diurnal",
    massKg: 600,
    sleepHours: 4.0,
    sleepWindow: [22, 3],
    matingSeason: "summer_estrus",
    socialPlayWeight: 0.9,
    shelterReliance: 1.0,
  },
  bull: {
    diet: "herbivore",
    chronotype: "diurnal",
    massKg: 850,
    sleepHours: 4.0,
    sleepWindow: [22, 3],
    matingSeason: "summer_estrus",
    socialPlayWeight: 0.9,
    shelterReliance: 1.0,
  },
  horse: {
    diet: "herbivore",
    chronotype: "diurnal",
    massKg: 500,
    sleepHours: 3.5,
    sleepWindow: [1, 4.5],
    matingSeason: "spring_breeding",
    socialPlayWeight: 1.4,
    shelterReliance: 1.0,
  },
  donkey: {
    diet: "herbivore",
    chronotype: "diurnal",
    massKg: 220,
    sleepHours: 4.5,
    sleepWindow: [23, 4],
    matingSeason: "spring_breeding",
    socialPlayWeight: 1.1,
    shelterReliance: 1.1,
  },

  // Carnivores & Pack Hunters
  wolf: {
    diet: "carnivore",
    chronotype: "crepuscular",
    massKg: 45,
    sleepHours: 9.0,
    sleepWindow: [10, 16], // Midday pack denning
    matingSeason: "spring_breeding",
    socialPlayWeight: 1.9,
    shelterReliance: 1.8,
  },
  "dire-wolf": {
    diet: "carnivore",
    chronotype: "nocturnal",
    massKg: 80,
    sleepHours: 8.5,
    sleepWindow: [8, 16],
    matingSeason: "spring_breeding",
    socialPlayWeight: 1.8,
    shelterReliance: 1.9,
  },
  coyote: {
    diet: "carnivore",
    chronotype: "nocturnal",
    massKg: 14,
    sleepHours: 10.0,
    sleepWindow: [7, 16],
    matingSeason: "spring_breeding",
    socialPlayWeight: 1.6,
    shelterReliance: 1.8,
  },
  fox: {
    diet: "carnivore",
    chronotype: "nocturnal",
    massKg: 7,
    sleepHours: 10.5,
    sleepWindow: [7, 17],
    matingSeason: "spring_breeding",
    socialPlayWeight: 1.7,
    shelterReliance: 2.2, // Underground earth/den
  },
  cougar: {
    diet: "carnivore",
    chronotype: "crepuscular",
    massKg: 65,
    sleepHours: 11.0,
    sleepWindow: [9, 17],
    matingSeason: "year_round",
    socialPlayWeight: 0.8,
    shelterReliance: 1.7,
  },

  // Omnivores & Large Beasts
  bear: {
    diet: "omnivore",
    chronotype: "diurnal",
    massKg: 320,
    sleepHours: 8.0,
    sleepWindow: [22, 6],
    winterHibernator: true, // Denning during winter
    matingSeason: "summer_estrus",
    socialPlayWeight: 1.1,
    shelterReliance: 2.5, // Cave / tree hollow den
  },
  "short-faced-bear": {
    diet: "omnivore",
    chronotype: "cathemeral",
    massKg: 750,
    sleepHours: 7.5,
    sleepWindow: [22, 5],
    winterHibernator: true,
    matingSeason: "summer_estrus",
    socialPlayWeight: 0.9,
    shelterReliance: 2.4,
  },
  boar: {
    diet: "omnivore",
    chronotype: "crepuscular",
    massKg: 95,
    sleepHours: 7.5,
    sleepWindow: [10, 16],
    matingSeason: "autumn_rut",
    socialPlayWeight: 1.4,
    shelterReliance: 1.6, // Thick brush wallow
  },

  // Small Game & Critters (High frequency metabolism)
  rabbit: {
    diet: "herbivore",
    chronotype: "crepuscular",
    massKg: 2.2,
    sleepHours: 8.5,
    sleepWindow: [10, 17],
    matingSeason: "spring_breeding",
    socialPlayWeight: 1.6,
    shelterReliance: 2.8, // Warrens / burrows
  },
  hare: {
    diet: "herbivore",
    chronotype: "crepuscular",
    massKg: 3.5,
    sleepHours: 8.0,
    sleepWindow: [10, 17],
    matingSeason: "spring_breeding",
    socialPlayWeight: 1.5,
    shelterReliance: 2.0,
  },
  squirrel: {
    diet: "herbivore",
    chronotype: "diurnal",
    massKg: 0.5,
    sleepHours: 14.0,
    sleepWindow: [19, 6],
    matingSeason: "spring_breeding",
    socialPlayWeight: 1.8,
    shelterReliance: 2.6, // Drey / tree nest
  },
  porcupine: {
    diet: "herbivore",
    chronotype: "nocturnal",
    massKg: 10,
    sleepHours: 11.0,
    sleepWindow: [6, 17],
    winterHibernator: true,
    matingSeason: "autumn_rut",
    socialPlayWeight: 0.7,
    shelterReliance: 2.2,
  },
  raccoon: {
    diet: "omnivore",
    chronotype: "nocturnal",
    massKg: 8.5,
    sleepHours: 12.0,
    sleepWindow: [6, 18],
    winterHibernator: true,
    matingSeason: "spring_breeding",
    socialPlayWeight: 1.6,
    shelterReliance: 2.3,
  },
  quail: {
    diet: "herbivore",
    chronotype: "diurnal",
    massKg: 0.25,
    sleepHours: 9.5,
    sleepWindow: [20, 5.5],
    matingSeason: "spring_breeding",
    socialPlayWeight: 1.3,
    shelterReliance: 1.5,
  },
  raven: {
    diet: "omnivore",
    chronotype: "diurnal",
    massKg: 1.2,
    sleepHours: 10.0,
    sleepWindow: [19.5, 5.5],
    matingSeason: "spring_breeding",
    socialPlayWeight: 2.0, // Highly intelligent and playful
    shelterReliance: 1.6,
  },

  // Monsters & Humanoid NPCs
  goblin: {
    diet: "omnivore",
    chronotype: "nocturnal",
    massKg: 35,
    sleepHours: 7.0,
    sleepWindow: [8, 15],
    matingSeason: "year_round",
    socialPlayWeight: 1.5,
    shelterReliance: 2.0,
  },
  orc: {
    diet: "carnivore",
    chronotype: "cathemeral",
    massKg: 140,
    sleepHours: 6.5,
    sleepWindow: [23, 5.5],
    matingSeason: "year_round",
    socialPlayWeight: 1.2,
    shelterReliance: 1.6,
  },
  troll: {
    diet: "carnivore",
    chronotype: "nocturnal",
    massKg: 420,
    sleepHours: 9.0,
    sleepWindow: [6, 15],
    winterHibernator: true, // Cave torpor
    matingSeason: "year_round",
    socialPlayWeight: 0.6,
    shelterReliance: 2.6,
  },
  human: {
    diet: "omnivore",
    chronotype: "diurnal",
    massKg: 75,
    sleepHours: 8.0,
    sleepWindow: [22, 6],
    matingSeason: "year_round",
    socialPlayWeight: 1.5,
    shelterReliance: 2.5, // Houses / inns
  },
};

/**
 * Calculates a complete biological and allometric metabolic profile for a species.
 */
export function getSpeciesBioProfile(speciesId: string): SpeciesBioProfile {
  const normId = speciesId.toLowerCase().trim();
  const base = SPECIES_BASE_DATA[normId] ?? {
    diet: "herbivore" as DietType,
    chronotype: "crepuscular" as Chronotype,
    massKg: 100,
    sleepHours: 7.0,
    sleepWindow: [22, 5] as [number, number],
  };

  // Adjust adult mass by real visual scale if known
  const scale = SPECIES_NATURAL_SCALE[normId] ?? 1.0;
  // If scale is drastically different from default 1.0 (e.g. 0.42 for deer),
  // base.massKg is already the real natural adult mass.
  const adultMassKg = Math.max(0.1, base.massKg);

  // Kleiber's Law: BMR = 70 * M^0.75 (kcal/day)
  const bmrKcalPerDay = Math.round(70 * Math.pow(adultMassKg, 0.75));

  // Stomach capacity: ~8% body weight for herbivores, ~4.5% for carnivores/omnivores
  const stomachCapacityKg = Math.round(
    adultMassKg * (base.diet === "herbivore" ? 0.08 : 0.045) * 100,
  ) / 100;

  // Natural feeding frequency bouts per day: B = 4.2 * M^-0.25
  const feedingBoutsPerDay = Math.max(1, Math.round(4.2 * Math.pow(adultMassKg, -0.25)));

  // Digestion transit delay (hours before excretion urge peaks after meals):
  // Small critters: ~1.8h, medium: ~3.5h, large: ~5.5h
  const digestionTransitHours = Math.round((1.2 + 1.8 * Math.pow(adultMassKg, 0.18)) * 10) / 10;

  // Water turnover: W = 0.15 * M^0.80 liters per sim-day
  const waterTurnoverLitersPerDay = Math.round(0.15 * Math.pow(adultMassKg, 0.8) * 100) / 100;
  const drinkingBoutsPerDay = Math.max(1, Math.round(2.8 * Math.pow(adultMassKg, -0.15)));

  return {
    speciesId: normId,
    diet: base.diet,
    chronotype: base.chronotype,
    adultMassKg,
    bmrKcalPerDay,
    stomachCapacityKg,
    feedingBoutsPerDay,
    digestionTransitHours,
    waterTurnoverLitersPerDay,
    drinkingBoutsPerDay,
    sleepHoursPerDay: base.sleepHours,
    sleepWindowHours: base.sleepWindow,
    winterHibernator: base.winterHibernator ?? false,
    matingSeason: base.matingSeason ?? "year_round",
    socialPlayWeight: base.socialPlayWeight ?? 1.2,
    shelterReliance: base.shelterReliance ?? 1.2,
  };
}
