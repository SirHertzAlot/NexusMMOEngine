/**
 * The Modular Fantasy Hero's recolourable regions.
 *
 * The pack's four mask textures (PolygonFantasyHero_Texture_Mask_01..04)
 * mark each region DARK on white in one colour channel. Which channel is
 * which was measured from the parts that use them (docs/CHARACTER-PLAN.md):
 * skin on heads, ears and bare limbs; hair on hair, brows and beards; the
 * armour's cloth, metal and leather on the body sets. `scar` and `bodyArt`
 * are masked but no base part uses them.
 *
 * Defaults are the atlas's own swatch colours (sRGB), so a character with
 * no colour choices looks exactly like the pack.
 *
 * Browser- and Node-safe.
 */

export const COLOUR_SLOTS = [
  "skin",
  "stubble",
  "scar",
  "hair",
  "bodyArt",
  "primary",
  "secondary",
  "metalPrimary",
  "metalSecondary",
  "metalDark",
  "leatherPrimary",
  "leatherSecondary",
] as const;
export type ColourSlot = (typeof COLOUR_SLOTS)[number];

/** Where a colour's region is marked: mask texture (0..3) and channel (0 R, 1 G, 2 B). */
export const MASK_CHANNELS: Readonly<Record<ColourSlot, readonly [mask: number, channel: number]>> = {
  primary: [0, 0],
  secondary: [0, 1],
  bodyArt: [0, 2],
  metalPrimary: [1, 0],
  metalSecondary: [1, 1],
  metalDark: [1, 2],
  skin: [2, 0],
  stubble: [2, 1],
  scar: [2, 2],
  leatherPrimary: [3, 0],
  leatherSecondary: [3, 1],
  hair: [3, 2],
};

/** The atlas's swatch colours: what each region looks like unrecoloured. */
export const DEFAULT_COLOURS: Readonly<Record<ColourSlot, string>> = {
  skin: "#ffccae",
  stubble: "#edaf97",
  scar: "#cdb3a1",
  hair: "#433622",
  bodyArt: "#4566a9",
  primary: "#5c6e77",
  secondary: "#cea34d",
  metalPrimary: "#8b9095",
  metalSecondary: "#586065",
  metalDark: "#2d3237",
  leatherPrimary: "#48352a",
  leatherSecondary: "#5f5447",
};

/** Colours a player chooses at creation (the armour's keep their defaults). */
export const APPEARANCE_COLOURS = ["skin", "stubble", "scar", "hair", "bodyArt"] as const satisfies readonly ColourSlot[];

export const isHexColour = (s: string): boolean => /^#[0-9a-f]{6}$/i.test(s);
