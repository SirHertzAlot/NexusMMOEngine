/**
 * A character's look: gender, the part chosen per slot, and colours — and
 * the rules that turn it into the parts to show.
 *
 *  - Body slots default to the gender's starter armour (set 01).
 *  - A head is always shown (the gender's first head by default).
 *  - Mask heads show no eyebrows or facial hair.
 *  - A head covering hides what it covers (hair, facial hair).
 *  - Facial hair is male-only (the pack has no female set).
 *
 * validateLook checks a look against the catalog; `creation` also locks
 * the body to the starter armour (a new character chooses everything but
 * its armour). Browser- and Node-safe.
 */

import { APPEARANCE_COLOURS, COLOUR_SLOTS, DEFAULT_COLOURS, isHexColour, type ColourSlot } from "./colour-slots.js";
import {
  BODY_SLOTS,
  DETAIL_SLOTS,
  STARTER_SET,
  starterArmour,
  type CatalogPart,
  type Gender,
  type ModularCatalog,
  type Slot,
} from "./modular-catalog.js";

export interface CharacterLook {
  gender: Gender;
  /** Part name per slot; null or missing = nothing there (body slots: the starter set). */
  parts: Partial<Record<Slot, string | null>>;
  /** sRGB hex per colour slot; missing = the pack's own colour. */
  colours: Partial<Record<ColourSlot, string>>;
}

function index(catalog: ModularCatalog): Map<string, CatalogPart> {
  return new Map(catalog.parts.map((p) => [p.name, p]));
}

/** The parts a look shows, in slot order, after defaults and hiding. */
export function resolveLook(catalog: ModularCatalog, look: CharacterLook): CatalogPart[] {
  const byName = index(catalog);
  const fits = (name: string | null | undefined, slot: Slot): CatalogPart | null => {
    const p = name ? byName.get(name) : undefined;
    return p && p.slot === slot && (p.gender === null || p.gender === look.gender) ? p : null;
  };
  const starter = starterArmour(catalog, look.gender);
  const shown: CatalogPart[] = [];
  for (const slot of BODY_SLOTS) {
    const p = fits(look.parts[slot], slot) ?? byName.get(starter[slot])!;
    shown.push(p);
  }
  const head =
    fits(look.parts.head, "head") ??
    catalog.parts.find((p) => p.slot === "head" && p.gender === look.gender && !p.mask) ??
    null;
  if (head) shown.push(head);
  const covering = fits(look.parts.headCovering, "headCovering");
  const hidden = new Set<Slot>(covering?.hides ?? []);
  if (head?.mask) {
    hidden.add("eyebrows");
    hidden.add("facialHair");
  }
  for (const slot of DETAIL_SLOTS) {
    if (slot === "head" || hidden.has(slot)) continue;
    const p = fits(look.parts[slot], slot);
    if (p) shown.push(p);
  }
  return shown;
}

export interface LookProblem {
  field: string;
  message: string;
}

/**
 * Problems with a look (empty = valid). `creation`: a new character —
 * the body must be the starter armour, and only appearance colours may
 * be set.
 */
export function validateLook(catalog: ModularCatalog, look: CharacterLook, opts: { creation?: boolean } = {}): LookProblem[] {
  const problems: LookProblem[] = [];
  if (look.gender !== "male" && look.gender !== "female") {
    return [{ field: "gender", message: "must be male or female" }];
  }
  const byName = index(catalog);
  const slots = new Set<string>([...BODY_SLOTS, ...DETAIL_SLOTS]);
  for (const [slot, name] of Object.entries(look.parts ?? {})) {
    if (!slots.has(slot)) {
      problems.push({ field: `parts.${slot}`, message: "is not a slot" });
      continue;
    }
    if (name === null || name === undefined) continue;
    const p = byName.get(name);
    if (!p) problems.push({ field: `parts.${slot}`, message: `${name} is not a part` });
    else if (p.slot !== slot) problems.push({ field: `parts.${slot}`, message: `${name} belongs in ${p.slot}` });
    else if (p.gender !== null && p.gender !== look.gender) problems.push({ field: `parts.${slot}`, message: `${name} is for ${p.gender} characters` });
  }
  if (opts.creation) {
    for (const slot of BODY_SLOTS) {
      const name = look.parts?.[slot];
      if (name !== undefined && name !== null && byName.get(name)?.index !== STARTER_SET) {
        problems.push({ field: `parts.${slot}`, message: "a new character wears the starter armour" });
      }
    }
    for (const slot of ["helmet", "headCovering", "back", "shoulderRight", "shoulderLeft", "elbowRight", "elbowLeft", "hipsAttachment", "kneeRight", "kneeLeft"] as const) {
      if (look.parts?.[slot]) problems.push({ field: `parts.${slot}`, message: "armour attachments come later, not at creation" });
    }
  }
  const allowed = new Set<string>(opts.creation ? APPEARANCE_COLOURS : COLOUR_SLOTS);
  for (const [slot, colour] of Object.entries(look.colours ?? {})) {
    if (!allowed.has(slot)) problems.push({ field: `colours.${slot}`, message: opts.creation ? "not chosen at creation" : "is not a colour slot" });
    else if (typeof colour !== "string" || !isHexColour(colour)) problems.push({ field: `colours.${slot}`, message: "must be #rrggbb" });
  }
  return problems;
}

/** Natural skin tones, light to dark (sRGB). */
export const SKIN_TONES = [
  "#ffdbc4", "#f7d0b4", "#eac09e", "#e0ac86", "#c68a64", "#a86f4c", "#8d5524", "#6e4225", "#4f2f1c", "#3b2217",
] as const;
/** Natural hair colours (sRGB). */
export const HAIR_COLOURS = [
  "#0f0d0c", "#2a1d15", "#433622", "#6a4a2e", "#8b5a2b", "#a0522d", "#b8864b", "#d6b370", "#e8d5a3", "#9c9c9c", "#dcdcdc",
] as const;

/**
 * A random look within the catalog (character creation's randomise, and
 * generated NPCs). `rng` returns 0..1; the body is the starter armour.
 */
export function randomLook(catalog: ModularCatalog, gender: Gender, rng: () => number = Math.random): CharacterLook {
  const pick = <T>(xs: readonly T[]): T | undefined => (xs.length === 0 ? undefined : xs[Math.floor(rng() * xs.length)]);
  const of = (slot: Slot, filter: (p: CatalogPart) => boolean = () => true): string | undefined =>
    pick(catalog.parts.filter((p) => p.slot === slot && (p.gender === null || p.gender === gender) && filter(p)))?.name;
  const hair = pick(HAIR_COLOURS)!;
  const parts: CharacterLook["parts"] = {
    head: of("head", (p) => !p.mask),
    hair: rng() < 0.9 ? of("hair") : null,
    eyebrows: of("eyebrows"),
    facialHair: gender === "male" && rng() < 0.5 ? of("facialHair") : null,
    ears: rng() < 0.15 ? of("ears") : null,
  };
  const colours: CharacterLook["colours"] = { skin: pick(SKIN_TONES)!, hair };
  if (gender === "male") colours.stubble = hair;
  return { gender, parts, colours };
}

/** An sRGB hex colour scaled toward black (factor 0..1). */
function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * factor));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Every colour slot of a look, with the regions a player didn't choose
 * following the skin: body art is invisible (the skin colour) until chosen,
 * scars are a shade of the skin, and stubble is a darker skin on men.
 * Women have no stubble (facial hair is male-only), so theirs is always the
 * skin. Armour keeps the pack's colours.
 */
export function effectiveColours(look: CharacterLook): Record<ColourSlot, string> {
  const pick = (slot: ColourSlot): string | undefined => {
    const c = look.colours?.[slot];
    return c && isHexColour(c) ? c : undefined;
  };
  const skin = pick("skin") ?? DEFAULT_COLOURS.skin;
  const out = {} as Record<ColourSlot, string>;
  for (const slot of COLOUR_SLOTS) out[slot] = pick(slot) ?? DEFAULT_COLOURS[slot];
  out.skin = skin;
  out.bodyArt = pick("bodyArt") ?? skin;
  out.scar = pick("scar") ?? shade(skin, 0.92);
  out.stubble = look.gender === "male" ? (pick("stubble") ?? shade(skin, 0.88)) : skin;
  return out;
}

/** Longest look accepted as JSON (a full look is ~0.5 KB). */
export const LOOK_JSON_MAX = 2048;

/**
 * A look in canonical form: known slots only, in slot order, empty slots
 * dropped (missing means nothing there, or the starter body), colours
 * lower-case and in slot order. Two equal looks have equal JSON, so the
 * server can compare and intern them as strings.
 */
export function canonicalLook(look: CharacterLook): CharacterLook {
  const parts: CharacterLook["parts"] = {};
  for (const slot of [...BODY_SLOTS, ...DETAIL_SLOTS]) {
    const name = look.parts?.[slot];
    if (typeof name === "string" && name.length > 0) parts[slot] = name;
  }
  const colours: CharacterLook["colours"] = {};
  for (const slot of COLOUR_SLOTS) {
    const c = look.colours?.[slot];
    if (typeof c === "string" && isHexColour(c)) colours[slot] = c.toLowerCase();
  }
  return { gender: look.gender, parts, colours };
}

/** A look as it travels and is stored: canonical JSON. */
export function lookToJson(look: CharacterLook): string {
  return JSON.stringify(canonicalLook(look));
}

/**
 * A look from untrusted data (a message, a database row, a wire string):
 * the canonical look, or null when it isn't one. Unknown slots are
 * dropped; whether the parts exist is validateLook's job.
 */
export function parseLook(raw: unknown): CharacterLook | null {
  let value = raw;
  if (typeof value === "string") {
    if (value.length > LOOK_JSON_MAX) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.gender !== "male" && v.gender !== "female") return null;
  const isRecord = (x: unknown): x is Record<string, unknown> =>
    x === undefined || (typeof x === "object" && x !== null && !Array.isArray(x));
  if (!isRecord(v.parts) || !isRecord(v.colours)) return null;
  for (const name of Object.values(v.parts ?? {})) {
    if (name !== null && (typeof name !== "string" || name.length > 64)) return null;
  }
  for (const c of Object.values(v.colours ?? {})) {
    if (typeof c !== "string" || c.length > 16) return null;
  }
  return canonicalLook({
    gender: v.gender,
    parts: (v.parts ?? {}) as CharacterLook["parts"],
    colours: (v.colours ?? {}) as CharacterLook["colours"],
  });
}
