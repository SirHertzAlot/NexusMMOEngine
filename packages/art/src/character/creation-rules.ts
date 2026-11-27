/**
 * What a player may choose when creating a character (roadmap EB7).
 *
 * These choices were three hardcoded lists in three places: the client's
 * character screen held the part categories and the colour swatches, and
 * `validateLook`'s creation mode held the slots and colours the server
 * would accept — written out as a denylist of the ten armour attachments,
 * which happened to be the complement of the five the client offered. A
 * game that wants ears off, a third face category on, or its own skin
 * palette had to edit two packages and hope they still agreed.
 *
 * `DEFAULT_CREATION_RULES` is exactly what those lists said, so a game
 * with no rules file behaves as before. A game that writes one gets
 * `content/character-creation.json`, which the server validates against,
 * the client builds its pickers from, and the editor edits.
 *
 * Pure, browser- and Node-safe: no file reading here. The server's loader
 * is engine-core's (`characters/creation-settings.ts`), the editor's form
 * is `apps/editor/src/creation-rules.ts`.
 */

import { APPEARANCE_COLOURS, COLOUR_SLOTS, type ColourSlot } from "./colour-slots.js";
import { BODY_SLOTS, DETAIL_SLOTS, STARTER_SET, type CatalogPart, type Gender, type ModularCatalog, type Slot } from "./modular-catalog.js";
import { HAIR_COLOURS, SKIN_TONES, type CharacterLook, type LookProblem } from "./look.js";

/** Body art swatches: the pack's mask region is a flat colour, so these are inks. */
export const BODY_ART_COLOURS = ["#2b4c8c", "#4566a9", "#6b2f8f", "#8c2b2b", "#2f6b3a", "#1c1c1c", "#c8a24a", "#e8e8e8"] as const;
/** Scar swatches: lighter and darker than skin, never a colour skin cannot be. */
export const SCAR_COLOURS = ["#e6b8a2", "#c98f7a", "#a86d5c", "#7a4a3c"] as const;

/** A part category offered at creation: one slot, a row of choices in the client. */
export interface CreationPart {
  slot: Slot;
  /** May be left empty ("none" steps through the row). */
  optional: boolean;
  /** Offered to this gender only; omitted means both. */
  gender?: Gender;
}

/** A colour offered at creation, with the swatches the screen shows for it. */
export interface CreationColour {
  slot: ColourSlot;
  swatches: readonly string[];
  /** May be left unset (the region follows the skin). */
  optional: boolean;
  gender?: Gender;
}

export interface CreationRules {
  /** The genders a new character may be. */
  genders: readonly Gender[];
  /** A new character wears the starter armour and cannot change it. */
  lockBodyToStarter: boolean;
  /** The part categories offered, in the order the screen shows them. */
  parts: readonly CreationPart[];
  /** The colours offered, in the order the screen shows them. */
  colours: readonly CreationColour[];
}

/**
 * The rules as the engine behaved before there was a file: the five face
 * categories the client offered, the five appearance colours the server
 * accepted, the body locked to the starter armour. Changing this changes what a game with no rules file does, so
 * it is checked against both old call sites in the tests.
 */
export const DEFAULT_CREATION_RULES: CreationRules = {
  genders: ["male", "female"],
  lockBodyToStarter: true,
  // Eyes, nose and mouth come with the face (the pack's heads).
  parts: [
    { slot: "head", optional: false },
    { slot: "hair", optional: true },
    { slot: "eyebrows", optional: true },
    { slot: "facialHair", optional: true, gender: "male" },
    { slot: "ears", optional: true },
  ],
  colours: [
    { slot: "skin", swatches: SKIN_TONES, optional: false },
    { slot: "hair", swatches: HAIR_COLOURS, optional: false },
    { slot: "stubble", swatches: HAIR_COLOURS, optional: true, gender: "male" },
    { slot: "scar", swatches: SCAR_COLOURS, optional: true },
    { slot: "bodyArt", swatches: BODY_ART_COLOURS, optional: true },
  ],
};

export interface CreationRuleProblem {
  path: string;
  message: string;
}

const isHex = (s: unknown): boolean => typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s);

/**
 * What is wrong with a rules document (empty: usable). Structural only —
 * whether a part slot has any parts in it is the catalog's business, and
 * a server without the art pack has no catalog to ask.
 */
export function creationRuleProblems(rules: CreationRules): CreationRuleProblem[] {
  const problems: CreationRuleProblem[] = [];
  const genders = new Set(rules.genders);
  if (genders.size === 0) problems.push({ path: "genders", message: "a character has to be something: list at least one gender" });
  for (const g of rules.genders) {
    if (g !== "male" && g !== "female") problems.push({ path: "genders", message: `${String(g)} is not a gender the pack has parts for` });
  }
  const slots = new Set<string>(DETAIL_SLOTS);
  const seenPart = new Set<string>();
  rules.parts.forEach((p, i) => {
    if (!slots.has(p.slot)) {
      problems.push({ path: `parts.${i}.slot`, message: `${p.slot} is not a slot that can be chosen at creation` });
    } else if (seenPart.has(p.slot)) {
      problems.push({ path: `parts.${i}.slot`, message: `${p.slot} is offered twice` });
    }
    seenPart.add(p.slot);
    if (p.gender !== undefined && !genders.has(p.gender)) {
      problems.push({ path: `parts.${i}.gender`, message: `offered to ${p.gender} only, and ${p.gender} is not a gender here` });
    }
  });
  if (!seenPart.has("head")) problems.push({ path: "parts", message: "a character always shows a head: offer the head category" });
  if (rules.parts.some((p) => p.slot === "head" && p.optional)) {
    problems.push({ path: "parts", message: "the head cannot be optional" });
  }
  const colourSlots = new Set<string>(COLOUR_SLOTS);
  const seenColour = new Set<string>();
  rules.colours.forEach((c, i) => {
    if (!colourSlots.has(c.slot)) problems.push({ path: `colours.${i}.slot`, message: `${c.slot} is not a colour slot` });
    else if (seenColour.has(c.slot)) problems.push({ path: `colours.${i}.slot`, message: `${c.slot} is offered twice` });
    seenColour.add(c.slot);
    if (c.swatches.length === 0) problems.push({ path: `colours.${i}.swatches`, message: "a colour with no swatches cannot be chosen" });
    c.swatches.forEach((s, j) => {
      if (!isHex(s)) problems.push({ path: `colours.${i}.swatches.${j}`, message: "must be #rrggbb" });
    });
    if (c.gender !== undefined && !genders.has(c.gender)) {
      problems.push({ path: `colours.${i}.gender`, message: `offered to ${c.gender} only, and ${c.gender} is not a gender here` });
    }
  });
  return problems;
}

/** The slots a player may set at creation under these rules. */
export const creationSlots = (rules: CreationRules): Set<Slot> => new Set(rules.parts.map((p) => p.slot));

/** The colour slots a player may set at creation under these rules. */
export const creationColourSlots = (rules: CreationRules): Set<ColourSlot> => new Set(rules.colours.map((c) => c.slot));

/** The categories offered to `gender`, in order. */
export const partsForGender = (rules: CreationRules, gender: Gender): CreationPart[] =>
  rules.parts.filter((p) => p.gender === undefined || p.gender === gender);

/** The colours offered to `gender`, in order. */
export const coloursForGender = (rules: CreationRules, gender: Gender): CreationColour[] =>
  rules.colours.filter((c) => c.gender === undefined || c.gender === gender);

/**
 * A rules document read from JSON, with every missing field filled from
 * the defaults, or what is wrong with it. Tolerant on purpose: a file
 * that sets only `maxCharacters` is a legitimate file, and a game should
 * not have to restate the five face categories to change one number.
 */
export function parseCreationRules(raw: unknown): { rules: CreationRules } | { problems: CreationRuleProblem[] } {
  if (raw === null || raw === undefined) return { rules: DEFAULT_CREATION_RULES };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { problems: [{ path: "", message: "character creation rules must be an object" }] };
  }
  const doc = raw as Record<string, unknown>;
  const problems: CreationRuleProblem[] = [];
  const list = <T>(key: string, value: unknown, read: (v: Record<string, unknown>, i: number) => T | null, fallback: readonly T[]): readonly T[] => {
    if (value === undefined) return fallback;
    if (!Array.isArray(value)) {
      problems.push({ path: key, message: "must be a list" });
      return fallback;
    }
    const out: T[] = [];
    value.forEach((v, i) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        problems.push({ path: `${key}.${i}`, message: "must be an object" });
        return;
      }
      const row = read(v as Record<string, unknown>, i);
      if (row) out.push(row);
    });
    return out;
  };

  const genders =
    doc.genders === undefined
      ? DEFAULT_CREATION_RULES.genders
      : Array.isArray(doc.genders)
        ? (doc.genders as Gender[])
        : (problems.push({ path: "genders", message: "must be a list" }), DEFAULT_CREATION_RULES.genders);
  if (doc.maxCharacters !== undefined) {
    // One owner per number: how many characters an account may hold is
    // content/rules/social.json's `characters.slots`, which the gateway
    // already reads and can change live.
    problems.push({ path: "maxCharacters", message: "how many characters an account holds is social.json's characters.slots" });
  }
  const lockBodyToStarter =
    doc.lockBodyToStarter === undefined
      ? DEFAULT_CREATION_RULES.lockBodyToStarter
      : typeof doc.lockBodyToStarter === "boolean"
        ? doc.lockBodyToStarter
        : (problems.push({ path: "lockBodyToStarter", message: "must be true or false" }), DEFAULT_CREATION_RULES.lockBodyToStarter);

  const parts = list<CreationPart>("parts", doc.parts, (v, i) => {
    if (typeof v.slot !== "string") {
      problems.push({ path: `parts.${i}.slot`, message: "must name a slot" });
      return null;
    }
    // A character always shows a head, so the head category is required
    // whatever the file leaves out; saying `optional: true` for it is an
    // error rather than something to quietly fix.
    const p: CreationPart = { slot: v.slot as Slot, optional: v.slot === "head" ? v.optional === true : v.optional !== false };
    if (typeof v.gender === "string") p.gender = v.gender as Gender;
    return p;
  }, DEFAULT_CREATION_RULES.parts);

  const colours = list<CreationColour>("colours", doc.colours, (v, i) => {
    if (typeof v.slot !== "string") {
      problems.push({ path: `colours.${i}.slot`, message: "must name a colour slot" });
      return null;
    }
    const swatches = Array.isArray(v.swatches) ? (v.swatches as unknown[]).map(String) : [];
    if (!Array.isArray(v.swatches)) problems.push({ path: `colours.${i}.swatches`, message: "must be a list of #rrggbb colours" });
    const c: CreationColour = { slot: v.slot as ColourSlot, swatches, optional: v.optional !== false };
    if (typeof v.gender === "string") c.gender = v.gender as Gender;
    return c;
  }, DEFAULT_CREATION_RULES.colours);

  const rules: CreationRules = { genders, lockBodyToStarter, parts, colours };
  problems.push(...creationRuleProblems(rules));
  return problems.length > 0 ? { problems } : { rules };
}

/**
 * The default rules as a document, for writing the first
 * `content/character-creation.json` from the editor: every field spelled
 * out, so what the engine does is on the page rather than implied.
 */
export const creationRulesDocument = (rules: CreationRules = DEFAULT_CREATION_RULES): Record<string, unknown> => ({
  genders: [...rules.genders],
  lockBodyToStarter: rules.lockBodyToStarter,
  parts: rules.parts.map((p) => ({ slot: p.slot, optional: p.optional, ...(p.gender ? { gender: p.gender } : {}) })),
  colours: rules.colours.map((c) => ({ slot: c.slot, optional: c.optional, swatches: [...c.swatches], ...(c.gender ? { gender: c.gender } : {}) })),
});

/** The appearance colours the engine accepted before the rules file existed. */
export const LEGACY_CREATION_COLOURS: readonly ColourSlot[] = APPEARANCE_COLOURS;

/**
 * What is wrong with a look *as a new character's* (empty: a player may
 * choose it). This is the half of the old `validateLook(…, { creation:
 * true })` that a game can change, and it now reads off the rules
 * instead of a denylist that had to be kept as the complement of the
 * client's pickers:
 *
 *  - the body is the starter armour, when the rules lock it;
 *  - nothing is set in a slot the rules do not offer (the ten armour
 *    attachments, under the defaults — the same ten the old denylist
 *    spelled out);
 *  - no colour is set that the rules do not offer;
 *  - the gender is one the rules allow, and a category offered to the
 *    other gender is not used.
 *
 * Run it beside `validateLook`, which answers the catalog questions.
 */
export function creationLookProblems(catalog: ModularCatalog, look: CharacterLook, rules: CreationRules = DEFAULT_CREATION_RULES): LookProblem[] {
  const problems: LookProblem[] = [];
  if (!rules.genders.includes(look.gender)) {
    return [{ field: "gender", message: `a new character here is ${rules.genders.join(" or ")}` }];
  }
  const byName = new Map<string, CatalogPart>(catalog.parts.map((p) => [p.name, p]));
  if (rules.lockBodyToStarter) {
    for (const slot of BODY_SLOTS) {
      const name = look.parts?.[slot];
      if (name !== undefined && name !== null && byName.get(name)?.index !== STARTER_SET) {
        problems.push({ field: `parts.${slot}`, message: "a new character wears the starter armour" });
      }
    }
  }
  const offered = partsForGender(rules, look.gender);
  const offeredSlots = new Set<Slot>(offered.map((p) => p.slot));
  for (const slot of DETAIL_SLOTS) {
    if (look.parts?.[slot] && !offeredSlots.has(slot)) {
      const elsewhere = rules.parts.find((p) => p.slot === slot);
      problems.push({
        field: `parts.${slot}`,
        message: elsewhere?.gender ? `${slot} is offered to ${elsewhere.gender} characters` : "is not chosen at creation",
      });
    }
  }
  const offeredColours = new Set<ColourSlot>(coloursForGender(rules, look.gender).map((c) => c.slot));
  for (const slot of Object.keys(look.colours ?? {}) as ColourSlot[]) {
    if (!offeredColours.has(slot)) {
      const elsewhere = rules.colours.find((c) => c.slot === slot);
      problems.push({
        field: `colours.${slot}`,
        message: elsewhere?.gender ? `${slot} is chosen by ${elsewhere.gender} characters` : "not chosen at creation",
      });
    }
  }
  return problems;
}
