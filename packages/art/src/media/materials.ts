/**
 * Toon and surface materials as data (content/materials/materials.json).
 *
 * - `toon`: the cel shading every toon material starts from: the lit/shadow
 *   band edges, stepped highlight, rim light, and the shadow ramp colours
 *   per material row (day and night).
 * - `surfaces`: per terrain surface layer (by id, as in the surface
 *   manifest), the albedo tint and the tile size, plus the footstep sound
 *   it answers with (an audio event id from content/audio/events.json).
 */
import { checker, isObj, type MediaIssue } from "./issue.js";

export const TOON_ROW_NAMES = ["skin", "cloth", "metal", "leather", "hair"] as const;
export type ToonRowName = (typeof TOON_ROW_NAMES)[number];
export type Rgb = [number, number, number];

export interface RampRow {
  /** [darkest, the shadow's edge], linear RGB 0..1. */
  day: [Rgb, Rgb];
  night: [Rgb, Rgb];
}

export interface ToonMaterial {
  band: [number, number];
  specular: number;
  rim: number;
  rimPower: number;
  ramp: Record<ToonRowName, RampRow>;
}

export interface SurfaceMaterial {
  tint: Rgb;
  tileMetres?: number;
  /** Audio event for a footstep on this surface. */
  footstep?: string;
}

export interface MaterialsDoc {
  version: 1;
  toon: ToonMaterial;
  surfaces: Record<string, SurfaceMaterial>;
}

const rgb = (v: unknown, max: number): v is Rgb =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max);

export function validateMaterials(doc: unknown): MediaIssue[] {
  const c = checker();
  if (!isObj(doc)) return [{ path: "", message: "materials must be an object" }];
  if (doc.version !== 1) c.add("version", "must be 1");
  if (!isObj(doc.toon)) c.add("toon", "must be an object");
  else {
    const t = doc.toon;
    const band = t.band;
    if (!Array.isArray(band) || band.length !== 2 || !band.every((n) => typeof n === "number" && n >= 0 && n <= 1) || band[0] > band[1]) {
      c.add("toon.band", "must be [shadow edge, lit edge] in 0..1, in order");
    }
    c.num(t, "specular", "toon.", 0, 1);
    c.num(t, "rim", "toon.", 0, 2);
    c.num(t, "rimPower", "toon.", 0.5, 32);
    if (!isObj(t.ramp)) c.add("toon.ramp", "must be an object");
    else {
      for (const row of TOON_ROW_NAMES) {
        const r = t.ramp[row];
        if (!isObj(r)) {
          c.add(`toon.ramp.${row}`, "missing");
          continue;
        }
        for (const when of ["day", "night"]) {
          const pair = r[when];
          if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((x) => rgb(x, 1))) c.add(`toon.ramp.${row}.${when}`, "must be two [r, g, b] colours in 0..1");
        }
      }
    }
  }
  if (!isObj(doc.surfaces)) c.add("surfaces", "must be an object");
  else {
    for (const [id, raw] of Object.entries(doc.surfaces)) {
      const p = `surfaces.${id}.`;
      if (!isObj(raw)) {
        c.add(`surfaces.${id}`, "must be an object");
        continue;
      }
      if (!rgb(raw.tint, 4)) c.add(`${p}tint`, "must be [r, g, b], each 0..4");
      if (raw.tileMetres !== undefined) c.num(raw, "tileMetres", p, 0.1, 100);
      if (raw.footstep !== undefined && (typeof raw.footstep !== "string" || raw.footstep === "")) c.add(`${p}footstep`, "must be an audio event id");
    }
  }
  return c.issues;
}
