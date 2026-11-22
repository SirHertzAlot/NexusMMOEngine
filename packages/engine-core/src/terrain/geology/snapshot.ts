/**
 * Geology snapshot: the macro "world skeleton" upstream of the survey.
 *
 * A snapshot is an explicit, editable description of one region's geology
 * frozen at one moment: tectonic plates (centre and velocity), cratons
 * (ancient stable cores), old sutures, and the widths and reliefs that turn
 * them into landforms. The generator (`generateGeologySpec`) writes one from
 * a seed, but everything downstream reads only the snapshot's numbers, never
 * the seed, so a designer can move a plate, add a craton or retag a province
 * and re-bake without the rest of the world changing.
 *
 * Coordinate frame: a planar region extract. World metres, x east, z south
 * (the survey's frame). The snapshot also records where that plane sits on
 * a sphere (azimuthal equidistant projection about an origin latitude and
 * longitude) and its scale (geological km per world km), so an imported
 * spherical model (lat/lon polygons on a unit sphere) maps to world metres
 * explicitly. Geology is frozen at runtime: nothing here runs in the tick.
 *
 * Determinism: classification uses only + − × ÷ and sqrt (identical on every
 * CPU); the warp noise comes from the strict-IEEE procgen addon; the
 * projections use det-math. Same snapshot → same bytes on every machine.
 *
 * Clean-room: written from the published concepts (Wilson cycle, cratons,
 * rifts, sutures, Voronoi plate mosaics as in our own terrain-kernel
 * `computeTectonics`). No code or data from any third-party tectonics
 * project is used.
 */

import { z } from "zod";
import { detAtan2, detCos, detSin } from "@mmo-engine/placement";

/** mulberry32, bit-identical to the survey's (kept local: world-spec imports this module). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const GEOLOGY_FORMAT = "nexus.geology/1";
export const GEOLOGY_GENERATOR = { name: "nexus-geology", version: "0.1.0" } as const;

/** Province kinds, in the order their numeric codes use (code = index). */
export const PROVINCE_KINDS = [
  "ocean",
  "platform",
  "craton",
  "orogen",
  "foreland",
  "rift",
  "arc",
  "suture",
  "transform",
] as const;
export type ProvinceKind = (typeof PROVINCE_KINDS)[number];
export const ProvinceKindSchema = z.enum(PROVINCE_KINDS);
export const kindCode = (k: ProvinceKind): number => PROVINCE_KINDS.indexOf(k);

const Pt = z.object({ x: z.number(), z: z.number() }).strict();

export const GeologySpecSchema = z
  .object({
    format: z.literal(GEOLOGY_FORMAT),
    /** Who wrote the snapshot and with what; recorded, never re-run. */
    generator: z
      .object({ name: z.string(), version: z.string(), params: z.record(z.string(), z.unknown()).default({}) })
      .strict(),
    /** Seed of the boundary warp noise only (plates and cratons are explicit). */
    seed: z.number().int().min(0),
    /** Geological age of the snapshot, Ma before present (a label for tools). */
    ageMa: z.number().min(0).default(0),
    frame: z
      .object({
        kind: z.literal("planar-region"),
        projection: z.literal("azimuthal-equidistant"),
        axes: z.literal("x-east-z-south"),
        units: z.literal("m"),
        /** Where world (0, 0) sits on the sphere. */
        originLatDeg: z.number().min(-89).max(89),
        originLonDeg: z.number().min(-180).max(180),
        planetRadiusKm: z.number().positive().default(6371),
        /** Geological kilometres per world kilometre (a 4 km world at 100 = 400 km of geology). */
        geoKmPerWorldKm: z.number().positive(),
      })
      .strict(),
    // Widths, reliefs and `strike` are set by full bakes, not by the survey alone: broader, higher belts (700 m wide,
    // 520 m high, crests unbroken) made 17% of a 4 km world mountain, left one town site where the designer range
    // leaves three, and their passes were too narrow for the places planner to route a road through. These keep as
    // many towns as the designer range, all joined by routes (docs/GEOLOGY.md, "Towns and roads"; guarded by
    // packages/settlement/test/geology-sites.test.ts).
    widths: z
      .object({
        /** Full width of a collision belt, metres. */
        orogenM: z.number().positive().default(300),
        /** Width of the volcanic arc on the overriding side of an ocean–continent margin. */
        arcM: z.number().positive().default(220),
        /** Width of the foreland basin beside a collision belt, on the down-going plate's side. */
        forelandM: z.number().positive().default(400),
        /** Full width of a continental rift. */
        riftM: z.number().positive().default(380),
        /** Full width of an old suture's worn ridge. */
        sutureM: z.number().positive().default(260),
        /** Full width of a transform shear zone. */
        transformM: z.number().positive().default(160),
        /** Rim over which a craton's plateau falls to the platform. */
        cratonRimM: z.number().positive().default(150),
        /** Boundary warp: how far plate edges wander, and the size of their bends. */
        warpM: z.number().min(0).default(260),
        warpScaleM: z.number().positive().default(1400),
        /** |relative normal velocity| below this (cm/yr) is a transform boundary. */
        transformBelowCmYr: z.number().min(0).default(0.6),
      })
      .strict()
      .prefault({}),
    relief: z
      .object({
        orogenM: z.number().default(400),
        arcM: z.number().default(300),
        forelandM: z.number().default(-14),
        riftM: z.number().default(-45),
        riftShoulderM: z.number().default(55),
        cratonM: z.number().default(20),
        sutureM: z.number().default(90),
        transformM: z.number().default(-12),
        oceanM: z.number().default(-70),
        /** Along-strike variation of a belt's crest, 0..1 (saddles become passes; 1 = saddles fall to the belt's foot). */
        strike: z.number().min(0).max(1).default(1),
        strikeScaleM: z.number().positive().default(1100),
        /** Ridges across a belt, 0..1 of its height, and their size. */
        ridges: z.number().min(0).max(1).default(0.4),
        ridgeScaleM: z.number().positive().default(450),
        /** Final blur radius, metres: softens kinks where provinces meet. */
        smoothM: z.number().min(0).default(40),
      })
      .strict()
      .prefault({}),
    plates: z
      .array(
        z
          .object({
            id: z.number().int().min(0).max(250),
            kind: z.enum(["continental", "oceanic"]),
            /** Plate centre (Voronoi site), world metres; may lie outside the world. */
            x: z.number(),
            z: z.number(),
            /** Velocity, cm/yr, world axes. */
            vx: z.number(),
            vz: z.number(),
          })
          .strict(),
      )
      .min(2),
    cratons: z
      .array(
        z
          .object({
            id: z.string().min(1),
            /** Centre, radii along its own axes (metres), and its long axis as a unit vector. */
            x: z.number(),
            z: z.number(),
            rx: z.number().positive(),
            rz: z.number().positive(),
            ax: z.number().default(1),
            az: z.number().default(0),
            ageGa: z.number().positive().default(2.5),
          })
          .strict(),
      )
      .default([]),
    sutures: z
      .array(z.object({ id: z.string().min(1), points: z.array(Pt).min(2), ageMa: z.number().min(0).default(400) }).strict())
      .default([]),
    /** Designer fixes: retag the province containing `at` (applied after classification). */
    overrides: z.array(z.object({ at: Pt, kind: ProvinceKindSchema }).strict()).default([]),
    /** Provinces smaller than this (m²) merge into their largest neighbour. */
    minProvinceArea: z.number().min(0).default(60_000),
  })
  .strict();

export type GeologySpec = z.infer<typeof GeologySpecSchema>;
export type GeologyPlate = GeologySpec["plates"][number];

export function parseGeologySpec(value: unknown): GeologySpec {
  return GeologySpecSchema.parse(value);
}

// ---------------------------------------------------------------------------
// Sphere <-> world (azimuthal equidistant about the frame origin)
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

/** Clamp to [-1, 1] and take acos with det-math (atan2 form, no libm). */
function detAcos(c: number): number {
  const x = Math.max(-1, Math.min(1, c));
  return detAtan2(Math.sqrt(Math.max(0, 1 - x * x)), x);
}

/** World metres -> latitude/longitude (degrees) on the frame's sphere. */
export function worldToLatLon(frame: GeologySpec["frame"], x: number, z: number): { latDeg: number; lonDeg: number } {
  // Plane coordinates in geological km: east = x, north = -z.
  const east = (x / 1000) * frame.geoKmPerWorldKm;
  const north = (-z / 1000) * frame.geoKmPerWorldKm;
  const rho = Math.sqrt(east * east + north * north);
  const phi0 = frame.originLatDeg * DEG;
  const lam0 = frame.originLonDeg * DEG;
  if (rho < 1e-12) return { latDeg: frame.originLatDeg, lonDeg: frame.originLonDeg };
  const c = rho / frame.planetRadiusKm;
  const sinC = detSin(c);
  const cosC = detCos(c);
  const sinP0 = detSin(phi0);
  const cosP0 = detCos(phi0);
  const sinPhi = cosC * sinP0 + (north * sinC * cosP0) / rho;
  const phi = detAtan2(sinPhi, Math.sqrt(Math.max(0, 1 - sinPhi * sinPhi)));
  const lam = lam0 + detAtan2(east * sinC, rho * cosP0 * cosC - north * sinP0 * sinC);
  let lonDeg = lam / DEG;
  if (lonDeg > 180) lonDeg -= 360;
  if (lonDeg < -180) lonDeg += 360;
  return { latDeg: phi / DEG, lonDeg };
}

/** Latitude/longitude (degrees) -> world metres. Inverse of {@link worldToLatLon}. */
export function latLonToWorld(frame: GeologySpec["frame"], latDeg: number, lonDeg: number): { x: number; z: number } {
  const phi = latDeg * DEG;
  const phi0 = frame.originLatDeg * DEG;
  const dLam = (lonDeg - frame.originLonDeg) * DEG;
  const cosC = detSin(phi0) * detSin(phi) + detCos(phi0) * detCos(phi) * detCos(dLam);
  const c = detAcos(cosC);
  const k = c < 1e-12 ? 1 : c / detSin(c);
  const east = frame.planetRadiusKm * k * detCos(phi) * detSin(dLam);
  const north = frame.planetRadiusKm * k * (detCos(phi0) * detSin(phi) - detSin(phi0) * detCos(phi) * detCos(dLam));
  return { x: (east / frame.geoKmPerWorldKm) * 1000, z: (-north / frame.geoKmPerWorldKm) * 1000 };
}

/** A unit-sphere vector (the representation tectonic globes use) -> world metres. */
export function unitVectorToWorld(frame: GeologySpec["frame"], v: { x: number; y: number; z: number }): { x: number; z: number } {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  const sz = v.z / len;
  const lat = detAtan2(sz, Math.sqrt(Math.max(0, 1 - sz * sz))) / DEG;
  const lon = detAtan2(v.y, v.x) / DEG;
  return latLonToWorld(frame, lat, lon);
}

// ---------------------------------------------------------------------------
// Generator: seed -> explicit snapshot
// ---------------------------------------------------------------------------

export interface GeologyGenerateParams {
  seed: number;
  /** World extent, metres (min..max on both axes). */
  min: number;
  max: number;
  plates?: number;
  /** Share of plates that are oceanic (0 = an all-continental region). */
  oceanicShare?: number;
  cratons?: number;
  sutures?: number;
  originLatDeg?: number;
  originLonDeg?: number;
  geoKmPerWorldKm?: number;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * A plausible collisional region, as explicit numbers: plates on a jittered
 * ring around the world centre (so several boundaries cross the world), one
 * plate moving into its neighbours (collision belts), one pulling away
 * (a rift), cratons in plate interiors, and old sutures across them.
 */
export function generateGeologySpec(p: GeologyGenerateParams): GeologySpec {
  const rng = mulberry32((p.seed ^ 0x6e01091) >>> 0);
  const span = p.max - p.min;
  const cx = (p.min + p.max) / 2;
  const n = p.plates ?? 6;
  const plates: GeologyPlate[] = [];
  // Centre plate plus a ring: unit directions from a fixed table rotated by a
  // seeded fraction (no trig at generation time beyond det-math).
  const turn0 = rng();
  for (let i = 0; i < n; i++) {
    const ring = i === 0 ? 0 : 0.42 + 0.18 * rng();
    const ang = 2 * Math.PI * ((i - 1) / Math.max(1, n - 1) + turn0) + 0.3 * (rng() - 0.5);
    const x = cx + span * ring * detCos(ang);
    const zc = cx + span * ring * detSin(ang);
    // Velocity: the centre plate converges on the ring; ring plates mostly
    // drift inward (collisions) with one drifting out (rift).
    let vx: number;
    let vz: number;
    if (i === 0) {
      const d = 2 * Math.PI * rng();
      vx = 2.2 * detCos(d);
      vz = 2.2 * detSin(d);
    } else {
      const out = i === 1 + Math.floor(rng() * (n - 1)) ? 1 : -1;
      const s = 1.5 + 2.5 * rng();
      const jitter = 0.6 * (rng() - 0.5);
      vx = out * s * detCos(ang + jitter);
      vz = out * s * detSin(ang + jitter);
    }
    const oceanic = i > 0 && rng() < (p.oceanicShare ?? 0);
    plates.push({ id: i, kind: oceanic ? "oceanic" : "continental", x: round2(x), z: round2(zc), vx: round2(vx), vz: round2(vz) });
  }
  const cratons: GeologySpec["cratons"] = [];
  for (let k = 0; k < (p.cratons ?? 2); k++) {
    const host = plates[k % plates.length];
    // Pull the craton from the plate centre toward the world, so it lands inside.
    const t = 0.35 + 0.25 * rng();
    const x = host.x + (cx - host.x) * t;
    const zc = host.z + (cx - host.z) * t;
    const a = 2 * Math.PI * rng();
    cratons.push({
      id: `C${k + 1}`,
      x: round2(x),
      z: round2(zc),
      rx: round2(span * (0.09 + 0.05 * rng())),
      rz: round2(span * (0.06 + 0.03 * rng())),
      ax: round2(detCos(a)),
      az: round2(detSin(a)),
      ageGa: round2(1.8 + 1.4 * rng()),
    });
  }
  const sutures: GeologySpec["sutures"] = [];
  for (let k = 0; k < (p.sutures ?? 1); k++) {
    const a = 2 * Math.PI * rng();
    const len = span * (0.35 + 0.2 * rng());
    const ox = cx + span * 0.2 * (rng() - 0.5);
    const oz = cx + span * 0.2 * (rng() - 0.5);
    const points = [];
    for (let s = 0; s <= 6; s++) {
      const f = s / 6 - 0.5;
      const bend = span * 0.04 * (rng() - 0.5);
      points.push({ x: round2(ox + len * f * detCos(a) - bend * detSin(a)), z: round2(oz + len * f * detSin(a) + bend * detCos(a)) });
    }
    sutures.push({ id: `S${k + 1}`, points, ageMa: round2(300 + 900 * rng()) });
  }
  return parseGeologySpec({
    format: GEOLOGY_FORMAT,
    generator: { ...GEOLOGY_GENERATOR, params: { ...p } },
    seed: p.seed,
    ageMa: 0,
    frame: {
      kind: "planar-region",
      projection: "azimuthal-equidistant",
      axes: "x-east-z-south",
      units: "m",
      originLatDeg: p.originLatDeg ?? 46,
      originLonDeg: p.originLonDeg ?? 8,
      planetRadiusKm: 6371,
      geoKmPerWorldKm: p.geoKmPerWorldKm ?? 100,
    },
    plates,
    cratons,
    sutures,
  });
}
