/**
 * Modular character catalog: what each part of the Modular Fantasy Hero
 * rig is, read from its name (`Chr_Torso_Male_05`, `Chr_Hair_12`, …).
 *
 * A character wears at most one part per slot. Body slots come in a male
 * and a female version; face details, hair, ears, head coverings and
 * attachments are shared. Set `01` of the body slots is the starter
 * armour. `Head_No_Elements` heads are the mask heads: no eyebrows or
 * facial hair show with them. Head coverings hide what they cover.
 *
 * Browser- and Node-safe: no three.js, no file access.
 */

export type Gender = "male" | "female";

/** Body slots: one mesh each, gendered, always worn. */
export const BODY_SLOTS = [
  "torso",
  "armUpperRight",
  "armUpperLeft",
  "armLowerRight",
  "armLowerLeft",
  "handRight",
  "handLeft",
  "hips",
  "legRight",
  "legLeft",
] as const;
export type BodySlot = (typeof BODY_SLOTS)[number];

/** Everything else a character can wear (optional unless noted). */
export const DETAIL_SLOTS = [
  "head", // required
  "hair",
  "eyebrows",
  "facialHair",
  "ears",
  "headCovering",
  "helmet",
  "back",
  "shoulderRight",
  "shoulderLeft",
  "elbowRight",
  "elbowLeft",
  "hipsAttachment",
  "kneeRight",
  "kneeLeft",
] as const;
export type DetailSlot = (typeof DETAIL_SLOTS)[number];

export type Slot = BodySlot | DetailSlot;

export interface CatalogPart {
  /** The mesh name in the rig, e.g. "Chr_Torso_Male_05". */
  name: string;
  slot: Slot;
  /** Null for parts both genders share. */
  gender: Gender | null;
  /** The number in the name (sets start at 00 or 01, per slot). */
  index: number;
  /** Mask heads: no eyebrows or facial hair show with them. */
  mask?: true;
  /** Head coverings: what they hide while worn. */
  hides?: Array<"hair" | "facialHair">;
}

/** The starter armour: body set 01 of the character's gender. */
export const STARTER_SET = 1;

interface Rule {
  re: RegExp;
  slot: Slot;
  gendered: boolean;
  mask?: true;
  hides?: Array<"hair" | "facialHair">;
}

const BODY_NAMES: Record<string, BodySlot> = {
  Torso: "torso",
  ArmUpperRight: "armUpperRight",
  ArmUpperLeft: "armUpperLeft",
  ArmLowerRight: "armLowerRight",
  ArmLowerLeft: "armLowerLeft",
  HandRight: "handRight",
  HandLeft: "handLeft",
  Hips: "hips",
  LegRight: "legRight",
  LegLeft: "legLeft",
};

// Order matters: the more specific head patterns come first.
const RULES: Rule[] = [
  { re: /^Chr_Head_No_Elements_(Male|Female)_(\d+)$/, slot: "head", gendered: true, mask: true },
  { re: /^Chr_Head_(Male|Female)_(\d+)$/, slot: "head", gendered: true },
  { re: /^Chr_Hair_(\d+)$/, slot: "hair", gendered: false },
  { re: /^Chr_Eyebrow_(Male|Female)_(\d+)$/, slot: "eyebrows", gendered: true },
  { re: /^Chr_FacialHair_(Male)_(\d+)$/, slot: "facialHair", gendered: true },
  { re: /^Chr_Ear_Ear_(\d+)$/, slot: "ears", gendered: false },
  { re: /^Chr_HeadCoverings_Base_Hair_(\d+)$/, slot: "headCovering", gendered: false, hides: [] },
  { re: /^Chr_HeadCoverings_No_FacialHair_(\d+)$/, slot: "headCovering", gendered: false, hides: ["facialHair"] },
  { re: /^Chr_HeadCoverings_No_Hair_(\d+)$/, slot: "headCovering", gendered: false, hides: ["hair"] },
  { re: /^Chr_HelmetAttachment_(\d+)$/, slot: "helmet", gendered: false },
  { re: /^Chr_BackAttachment_(\d+)$/, slot: "back", gendered: false },
  { re: /^Chr_ShoulderAttachRight_(\d+)$/, slot: "shoulderRight", gendered: false },
  { re: /^Chr_ShoulderAttachLeft_(\d+)$/, slot: "shoulderLeft", gendered: false },
  { re: /^Chr_ElbowAttachRight_(\d+)$/, slot: "elbowRight", gendered: false },
  { re: /^Chr_ElbowAttachLeft_(\d+)$/, slot: "elbowLeft", gendered: false },
  { re: /^Chr_HipsAttachment_(\d+)$/, slot: "hipsAttachment", gendered: false },
  { re: /^Chr_KneeAttachRight_(\d+)$/, slot: "kneeRight", gendered: false },
  { re: /^Chr_KneeAttachLeft_(\d+)$/, slot: "kneeLeft", gendered: false },
];

/** What a rig mesh is, or null for anything that isn't a modular part. */
export function parsePartName(name: string): CatalogPart | null {
  const body = /^Chr_(Torso|ArmUpperRight|ArmUpperLeft|ArmLowerRight|ArmLowerLeft|HandRight|HandLeft|Hips|LegRight|LegLeft)_(Male|Female)_(\d+)$/.exec(name);
  if (body) {
    return { name, slot: BODY_NAMES[body[1]], gender: body[2].toLowerCase() as Gender, index: Number(body[3]) };
  }
  for (const rule of RULES) {
    const m = rule.re.exec(name);
    if (!m) continue;
    const gender = rule.gendered ? (m[1].toLowerCase() as Gender) : null;
    const part: CatalogPart = { name, slot: rule.slot, gender, index: Number(m[m.length - 1]) };
    if (rule.mask) part.mask = true;
    if (rule.hides) part.hides = rule.hides;
    return part;
  }
  return null;
}

/** The catalog of a rig: every recognised part, sorted by slot, gender, index. */
export interface ModularCatalog {
  version: 1;
  parts: CatalogPart[];
}

/**
 * The converted rig's catalog.json (see convert-modular). Paths are
 * relative to the catalog file.
 */
export interface RiggedCatalog extends ModularCatalog {
  /** The skeleton every part binds to. */
  rig: string;
  /** Part name -> its skinned GLB. */
  files: Record<string, string>;
  /** The atlas and the four recolour masks (skin, hair, eyes, armour…). */
  textures: { base: string; masks: string[] };
}

export function buildCatalog(meshNames: Iterable<string>): { catalog: ModularCatalog; unknown: string[] } {
  const parts: CatalogPart[] = [];
  const unknown: string[] = [];
  for (const name of meshNames) {
    const p = parsePartName(name);
    if (p) parts.push(p);
    else unknown.push(name);
  }
  const slotOrder = new Map<Slot, number>([...BODY_SLOTS, ...DETAIL_SLOTS].map((s, i) => [s, i]));
  parts.sort(
    (a, b) =>
      slotOrder.get(a.slot)! - slotOrder.get(b.slot)! ||
      (a.gender ?? "").localeCompare(b.gender ?? "") ||
      Number(a.mask ?? false) - Number(b.mask ?? false) ||
      a.index - b.index,
  );
  return { catalog: { version: 1, parts }, unknown };
}

/** Parts a character of `gender` may wear in `slot` (shared parts included). */
export function partsFor(catalog: ModularCatalog, slot: Slot, gender: Gender): CatalogPart[] {
  return catalog.parts.filter((p) => p.slot === slot && (p.gender === null || p.gender === gender));
}

/** The starter armour: the gender's set-01 part for every body slot. */
export function starterArmour(catalog: ModularCatalog, gender: Gender): Record<BodySlot, string> {
  const out = {} as Record<BodySlot, string>;
  for (const slot of BODY_SLOTS) {
    const part = catalog.parts.find((p) => p.slot === slot && p.gender === gender && p.index === STARTER_SET);
    if (!part) throw new Error(`catalog: no starter ${slot} for ${gender}`);
    out[slot] = part.name;
  }
  return out;
}
