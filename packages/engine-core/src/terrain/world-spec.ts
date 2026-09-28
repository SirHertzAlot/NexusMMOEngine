/**
 * World spec — the checked-in description of a baked world: its size, the
 * coarse survey grid, the shape of the land and its mountain ranges, the
 * climate that plays over them, erosion, water, and the rules that turn
 * all of that into biomes.
 *
 * Biomes are not placed: they emerge. Each biome is a rule over what the
 * survey computed for a cell (temperature, rainfall, height, slope,
 * distance to water); biomes are tried in order and the first match wins,
 * so deserts land in rain shadows and swamps on low wet ground by the
 * water because that is where the rules find them.
 *
 * Validated with zod so a typo fails the bake loudly instead of silently
 * producing a different world. Distances are metres; heights are metres
 * above sea level unless stated. +x is east, +z is south (the bottom of
 * the world map).
 */

import * as fs from "node:fs";
import { z } from "zod";

/** A world edge. */
export const Side = z.enum(["north", "south", "east", "west"]);
export type Side = z.infer<typeof Side>;

/** A compass point the wind comes from. */
export const WindFrom = z.enum([
  "north",
  "north-east",
  "east",
  "south-east",
  "south",
  "south-west",
  "west",
  "north-west",
]);
export type WindFrom = z.infer<typeof WindFrom>;

/** Surface character a biome adds on top of the landform. */
export const BiomeShape = z.enum(["rolling", "ridged", "dunes", "flat"]);

/** An inclusive bound; either end may be left open. */
const Bound = z
  .object({ min: z.number().optional(), max: z.number().optional() })
  .strict()
  .refine((b) => b.min === undefined || b.max === undefined || b.min <= b.max, "min must be <= max");
export type Bound = z.infer<typeof Bound>;

/** What a survey cell must satisfy for a biome rule to claim it (every bound given). */
export const BiomeCondition = z
  .object({
    /** "land" = neither sea nor lake. */
    water: z.enum(["sea", "lake", "land"]).optional(),
    /** Mean temperature, °C. */
    tempC: Bound.optional(),
    /** Yearly rainfall, mm. */
    rainMm: Bound.optional(),
    /** Height above sea level, metres. */
    height: Bound.optional(),
    /** Ground slope, degrees. */
    slopeDeg: Bound.optional(),
    /** Distance to the sea, metres. */
    coastDistance: Bound.optional(),
    /** Distance to any water: sea, lake, or river. */
    waterDistance: Bound.optional(),
    /** Distance to fresh water: a lake or river. */
    freshwaterDistance: Bound.optional(),
    /**
     * Share of open sea within ~400 m, 0..1: high on exposed coasts and
     * headlands, low in inlets, lagoons, and inland.
     */
    seaExposure: Bound.optional(),
    /** 1 under glacier ice or an ice cap, 0 elsewhere. */
    ice: Bound.optional(),
    /** Distance to the nearest volcano's vent, metres (Infinity with none). */
    volcanoDistance: Bound.optional(),
    /** UV index (about 0–15). */
    uvIndex: Bound.optional(),
  })
  .strict();
export type BiomeCondition = z.infer<typeof BiomeCondition>;

export const BiomeSpecSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, "biome id: lowercase letters, digits, dashes"),
    /**
     * Where the biome forms: one condition, or several alternatives (any
     * one matching is enough). Omitted = everywhere (the catch-all).
     */
    when: z.union([BiomeCondition, z.array(BiomeCondition).min(1)]).optional(),
    /**
     * Surface character on top of the landform, blended across borders:
     * rolling / ridged hills of `relief` metres at `scale`; dunes whose
     * crests face the wind; flat ground settling `relief` metres above sea
     * level (swamps).
     */
    surface: z
      .object({ shape: BiomeShape, relief: z.number().min(0), scale: z.number().positive() })
      .strict()
      .optional(),
    /** Fine detail strength, 0..1 (0 = smooth, 1 = rough ground). */
    roughness: z.number().min(0).max(1),
  })
  .strict();

export const WorldSpecSchema = z
  .object({
    name: z.string().min(1),
    seed: z.number().int().min(0),
    /** World edge in chunks (square, centred on the origin). */
    sizeChunks: z.number().int().min(2).max(4096),
    chunkWorldSize: z.number().positive().default(16),
    /** Coarse survey grid cell, metres. */
    coarseCell: z.number().positive().default(8),
    /** Biome surface blend width across borders, metres. */
    blendWidth: z.number().positive().default(120),
    /** Fine detail height at roughness 1, metres. */
    detailAmplitude: z.number().min(0).default(1.5),
    /** Fine detail feature size, metres. */
    detailScale: z.number().positive().default(14),
    /** Regions per side for server ownership (sizeChunks must divide evenly). */
    regionsPerSide: z.number().int().min(1).default(1),

    land: z
      .object({
        seaLevel: z.number().default(0),
        coast: z
          .object({
            /** The edge the sea opens onto; the land runs off the opposite edge. */
            side: Side.default("south"),
            /**
             * Share of the world's edge that is sea, 0.25..0.75: the whole
             * `side` edge plus the stretches of the two neighbouring edges
             * nearest it. 0.6 = a peninsula.
             */
            waterEdge: z.number().min(0.25).max(0.75).default(0.6),
            /** How far the land reaches toward the sea edge, 0..1 of the world. */
            tip: z.number().gt(0).max(1).default(0.85),
            /** Peninsula taper: < 1 stays broad then narrows, > 1 narrows early. */
            taper: z.number().positive().default(0.7),
            /** How far the coastline wanders (bays, headlands), metres. */
            wander: z.number().min(0).default(300),
            /** Size of bays and headlands, metres. */
            wanderScale: z.number().positive().default(700),
          })
          .strict()
          .prefault({}),
        /** Deepest sea floor, metres below sea level. */
        shelfDepth: z.number().min(0).default(40),
        /** Distance offshore over which the floor falls to most of that depth. */
        shelfWidth: z.number().positive().default(300),
        /** Height the land climbs from the coast inland, metres. */
        rise: z.number().min(0).default(30),
        /** Distance over which most of that rise happens. */
        riseDistance: z.number().positive().default(1200),
        /** Broad swells over the landmass (±metres) and their size. */
        relief: z.number().min(0).default(25),
        reliefScale: z.number().positive().default(1500),
        /** Islands smaller than this (m²) sink; larger ones stay. */
        minIslandArea: z.number().min(0).default(20_000),
      })
      .strict()
      .prefault({}),

    ranges: z
      .object({
        /** Main chains, laid across the wind and kept apart. */
        count: z.number().int().min(0).default(1),
        /**
         * Where the first main chain is centred, world metres (x east, z
         * south); omitted = anywhere on the land (the seed picks). Its
         * volcanoes move with it.
         */
        center: z.object({ x: z.number(), z: z.number() }).strict().optional(),
        /** Crest height above the land, metres. */
        height: z.number().min(0).default(380),
        /** Full width of a range, metres. */
        width: z.number().positive().default(900),
        /** Length of a main chain, metres (shortened when the land is too small). */
        length: z.number().positive().default(3600),
        /** Spur ranges branching off the chains (they merge where they join). */
        spurs: z.number().int().min(0).default(3),
        spurLength: z.number().positive().default(1300),
        /** Spur height and width as a share of the chain's. */
        spurScale: z.number().min(0.2).max(1).default(0.75),
        /** Size of the ridges and valleys along a range, metres. */
        ridgeScale: z.number().positive().default(600),
        /** Ridge strength, 0..1 of the range height. */
        ridges: z.number().min(0).max(1).default(0.45),
        /** Smallest distance between a range's axis and the sea, metres. */
        coastClearance: z.number().min(0).default(350),
      })
      .strict()
      .prefault({}),

    climate: z
      .object({
        /** Where the prevailing wind comes from (it carries the sea's moisture). */
        wind: WindFrom.default("south-west"),
        /** Temperature at sea level on the sea edge, °C. */
        seaTempC: z.number().default(20),
        /** How much colder the far (land) edge is at sea level, °C. */
        inlandCoolingC: z.number().default(8),
        /**
         * How the cooling spreads toward the far edge: 1 = evenly; > 1 keeps
         * the middle mild and puts the cold in the far north (a frozen edge).
         */
        inlandCoolingCurve: z.number().positive().default(1),
        /** Cooling with height, °C per km (the real ~6.5 is too little for a 400 m world). */
        lapseCPerKm: z.number().min(0).default(40),
        /** Yearly rain on flat ground at the windward coast, mm. */
        rainMm: z.number().positive().default(1100),
        /** Distance over flat land in which the wind loses most of its moisture, metres. */
        dryDistance: z.number().positive().default(2500),
        /** Extra rain wrung out per metre the wind climbs (orographic lift). */
        orographic: z.number().min(0).default(0.006),
        /** Share of rain that evaporates back into the wind, 0..0.95. */
        recycling: z.number().min(0).max(0.95).default(0.35),
        /** Humidity (0..1) of air blowing in over the land edges. */
        inlandHumidity: z.number().min(0).max(1).default(0.35),
        /** The edge the sun stands over at noon (the equator side). */
        sunFrom: Side.default("south"),
        /** Noon sun elevation over the sea edge and over the far edge, degrees. */
        sunNoonAtSeaDeg: z.number().gt(0).max(90).default(62),
        sunNoonAtFarDeg: z.number().gt(0).max(90).default(32),
        /** Sun-facing slopes run this much warmer, shaded ones this much colder, °C. */
        aspectWarmingC: z.number().min(0).default(2),
        uv: z
          .object({
            /** UV index on flat open ground at sea level on the sea edge. */
            atSeaEdge: z.number().min(0).default(10),
            /** Share gained per km of height (thinner air; exaggerated like the lapse rate). */
            altitudeGainPerKm: z.number().min(0).default(0.6),
            /** Share cloud cuts where it rains twice the windward coast's rain. */
            cloudCut: z.number().min(0).max(1).default(0.4),
            /** Share snow and ice add by reflecting it. */
            snowReflection: z.number().min(0).default(0.6),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),

    erosion: z
      .object({
        /** Water droplets (spawned where it rains) and their strength. */
        droplets: z.number().int().min(0).default(150_000),
        strength: z.number().min(0).max(1).default(0.35),
        /** Steepest slope loose ground holds; steeper collapses into scree. */
        talusDeg: z.number().gt(0).lt(90).default(38),
        thermalPasses: z.number().int().min(0).default(30),
        /** River incision (stream power): passes and strength. */
        fluvialPasses: z.number().int().min(0).default(12),
        fluvialStrength: z.number().min(0).default(0.004),
      })
      .strict()
      .prefault({}),

    glaciers: z
      .object({
        /** Snow turns to ice where the mean temperature is at or below this, °C… */
        formBelowC: z.number().default(-2),
        /** …and at least this much of it falls a year, mm (drier cold ground is tundra). */
        minSnowMm: z.number().min(0).default(500),
        /** Ice melts where it is warmer than this, °C… */
        meltAboveC: z.number().default(1),
        /** …by this many metres of ice a year per °C above it… */
        meltRate: z.number().min(0).default(1.5),
        /**
         * …scaled by the sun: 0 = sun makes no difference; 0.8 = a slope with
         * half the sun of flat ground melts 40% slower, one with 1.5× melts
         * 40% faster (glaciers keep to the shade).
         */
        sunMelt: z.number().min(0).max(1).default(0.8),
        /** Carving passes (ice re-routes over the carved land each pass). */
        passes: z.number().int().min(0).default(5),
        /** How hard ice grinds its bed, and the most one pass can cut, metres. */
        strength: z.number().min(0).default(0.01),
        maxCutPerPassM: z.number().min(0).default(4),
        /** Tallest moraine a glacier leaves at its snout, metres. */
        moraineM: z.number().min(0).default(6),
      })
      .strict()
      .prefault({}),

    volcano: z
      .object({
        /** Volcanoes on the main chain (0 = none). */
        count: z.number().int().min(0).default(0),
        /** Crater rim height above the surrounding land's base, metres. */
        height: z.number().min(0).default(520),
        /** Cone base radius, metres. */
        radius: z.number().positive().default(650),
        craterRadius: z.number().min(0).default(70),
        craterDepth: z.number().min(0).default(45),
        /** Vent heat at the summit (keeps the crater clear of ice), °C, fading to 0 at the base. */
        heatC: z.number().min(0).default(10),
      })
      .strict()
      .prefault({}),

    rivers: z
      .object({
        /** Upstream area (m²) for a river, counted at the windward coast's rainfall. */
        minCatchment: z.number().positive().default(400_000),
        /** Deepest river bed carved, metres. */
        maxDepth: z.number().min(0).default(4),
      })
      .strict()
      .prefault({}),

    lakes: z
      .object({
        /** A hollow holds a lake where it is at least this deep (metres)… */
        minDepth: z.number().min(0).default(0.8),
        /** …and this large (m²)… */
        minArea: z.number().min(0).default(12_000),
        /** …and gets at least this much rain (mm); drier hollows stay dry. */
        minRainMm: z.number().min(0).default(350),
      })
      .strict()
      .prefault({}),

    /** Biome rules, tried in order; the last must be a catch-all (no `when`). */
    biomes: z.array(BiomeSpecSchema).min(1),
    /** Smallest biome patch kept, m²; smaller ones join their neighbours. */
    minBiomeArea: z.number().min(0).default(6_000),

    /**
     * Where players spawn: a point (x, z in metres), or the biggest region
     * of `biome` near the middle of the land. Default biome: plains when
     * the world has it, else the catch-all.
     */
    spawn: z
      .object({ biome: z.string().optional(), x: z.number().optional(), z: z.number().optional() })
      .strict()
      .refine((s) => (s.x === undefined) === (s.z === undefined), "spawn: give both x and z, or neither")
      .optional(),
  })
  .strict()
  .superRefine((w, ctx) => {
    if (w.sizeChunks % w.regionsPerSide !== 0) {
      ctx.addIssue({ code: "custom", message: `sizeChunks (${w.sizeChunks}) must be divisible by regionsPerSide (${w.regionsPerSide})` });
    }
    const ids = new Set<string>();
    for (const b of w.biomes) {
      if (ids.has(b.id)) ctx.addIssue({ code: "custom", message: `duplicate biome id "${b.id}"` });
      ids.add(b.id);
    }
    if (w.biomes.length > 255) ctx.addIssue({ code: "custom", message: "at most 255 biomes" });
    const last = w.biomes[w.biomes.length - 1];
    if (last.when !== undefined) {
      ctx.addIssue({ code: "custom", message: `the last biome ("${last.id}") must be a catch-all: give it no "when"` });
    }
    for (const b of w.biomes.slice(0, -1)) {
      if (b.when === undefined) {
        ctx.addIssue({ code: "custom", message: `biome "${b.id}" has no "when" but is not last: the biomes after it could never form` });
      }
    }
    const { waterEdge, tip } = w.land.coast;
    const sidesTurn = 1 - 2 * (waterEdge - 0.25);
    if (waterEdge > 0.25 && tip <= sidesTurn) {
      ctx.addIssue({
        code: "custom",
        message: `land.coast.tip (${tip}) must reach past where the side edges turn to sea (${sidesTurn.toFixed(2)} for waterEdge ${waterEdge})`,
      });
    }
    const spawnBiome = w.spawn?.biome;
    if (spawnBiome !== undefined && !ids.has(spawnBiome)) {
      ctx.addIssue({ code: "custom", message: `spawn biome "${spawnBiome}" is not one of the world's biomes` });
    }
  });

export type BiomeSpec = z.infer<typeof BiomeSpecSchema>;
export type WorldSpec = z.infer<typeof WorldSpecSchema>;

export function parseWorldSpec(value: unknown): WorldSpec {
  return WorldSpecSchema.parse(value);
}

export function loadWorldSpec(file: string): WorldSpec {
  return parseWorldSpec(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** World bounds in metres: chunks cx in [-size/2, size/2). */
export function worldBounds(spec: WorldSpec): { minChunk: number; maxChunk: number; min: number; max: number } {
  const half = Math.floor(spec.sizeChunks / 2);
  const minChunk = -half;
  const maxChunk = minChunk + spec.sizeChunks - 1;
  return {
    minChunk,
    maxChunk,
    min: minChunk * spec.chunkWorldSize,
    max: (maxChunk + 1) * spec.chunkWorldSize,
  };
}

/** Unit vector the wind blows toward (x east, z south). */
export function windVector(from: WindFrom): { x: number; z: number } {
  const toward: Record<WindFrom, [number, number]> = {
    north: [0, 1],
    "north-east": [-1, 1],
    east: [-1, 0],
    "south-east": [-1, -1],
    south: [0, -1],
    "south-west": [1, -1],
    west: [1, 0],
    "north-west": [1, 1],
  };
  const [x, z] = toward[from];
  const len = Math.hypot(x, z);
  return { x: x / len, z: z / len };
}
