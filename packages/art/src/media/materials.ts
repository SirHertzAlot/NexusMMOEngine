/**
 * Toon and surface materials as data (content/materials/materials.json).
 *
 * - `toon`: the cel shading every toon material starts from: the lit/shadow
 *   band edges, stepped highlight, rim light, and the shadow ramp colours
 *   per material row (day and night).
 * - `surfaces`: per terrain surface layer (by id, as in the surface
 *   manifest), the albedo tint and the tile size, plus the footstep sound
 *   it answers with (an audio event name from content/audio/events.json).
 *
 * Not the per-material files beside it (content/materials/<name>.json, art
 * `loadMaterial`): those define single materials, this is the global look.
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

/** Shading components a surface can carry: the cel look, or three's own PBR. */
export const SHADING_COMPONENTS = ["toon", "standard"] as const;
export type ShadingComponentId = (typeof SHADING_COMPONENTS)[number];

/** The things the client draws that carry shading components. */
export const SHADING_KINDS = ["model", "placeholder", "prefab"] as const;
export type ShadingKind = (typeof SHADING_KINDS)[number];

/**
 * Which shading components each kind of thing carries. Adding `toon` to a
 * kind is what makes it cell-shaded; `standard` leaves three's own PBR.
 * A kind named nowhere keeps the engine's default (toon).
 *
 * Modular characters are not here: the character kit shades its own
 * material (CharacterStyle, character/character-kit.ts).
 */
export interface ShadingDoc {
  kinds?: Partial<Record<ShadingKind, ShadingComponentId[]>>;
  /** The toon ramp row per kind (see TOON_ROW_NAMES). Default "cloth". */
  rows?: Partial<Record<ShadingKind, ToonRowName>>;
}

export interface MaterialsDoc {
  version: 1;
  toon: ToonMaterial;
  surfaces: Record<string, SurfaceMaterial>;
  /** Metres walked per footstep sound (default 1.7). */
  footstepStride?: number;
  /** Who is cell-shaded, by kind of thing (default: every kind). */
  shading?: ShadingDoc;
}

export const DEFAULT_FOOTSTEP_STRIDE = 1.7;

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
  if (doc.footstepStride !== undefined) c.num(doc, "footstepStride", "", 0.5, 5);
  if (doc.shading !== undefined) validateShading(doc.shading, c);
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

const known = (list: readonly string[], v: unknown): boolean => typeof v === "string" && list.includes(v);

/** Validate the `shading` block: who carries which shading component. */
function validateShading(shading: unknown, c: ReturnType<typeof checker>): void {
  if (!isObj(shading)) {
    c.add("shading", "must be an object");
    return;
  }
  if (shading.kinds !== undefined) {
    if (!isObj(shading.kinds)) c.add("shading.kinds", "must be an object");
    else {
      for (const [kind, ids] of Object.entries(shading.kinds)) {
        if (!known(SHADING_KINDS, kind)) c.add(`shading.kinds.${kind}`, `unknown kind (${SHADING_KINDS.join(", ")})`);
        else if (!Array.isArray(ids) || ids.some((id) => !known(SHADING_COMPONENTS, id)))
          c.add(`shading.kinds.${kind}`, `must be a list of ${SHADING_COMPONENTS.join(" / ")}`);
      }
    }
  }
  if (shading.rows !== undefined) {
    if (!isObj(shading.rows)) c.add("shading.rows", "must be an object");
    else {
      for (const [kind, row] of Object.entries(shading.rows)) {
        if (!known(SHADING_KINDS, kind)) c.add(`shading.rows.${kind}`, `unknown kind (${SHADING_KINDS.join(", ")})`);
        else if (!known(TOON_ROW_NAMES, row)) c.add(`shading.rows.${kind}`, `must be one of ${TOON_ROW_NAMES.join(", ")}`);
      }
    }
  }
}
