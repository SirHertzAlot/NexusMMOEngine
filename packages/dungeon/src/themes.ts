/**
 * Dungeon themes: what the generator reads from a theme (liquids, frozen
 * lakes, graveyards, bones, roots, icicles, the name pools), plus a free
 * `look` (palette, lights, particles) the renderer reads and the generator
 * passes through untouched.
 *
 * The five built-in themes are Dungeon Forge's (MIT, © 2026 Majid
 * Manzarpour; see THIRD_PARTY_NOTICES.md). A game adds or replaces themes
 * with a JSON file of the same shape (`loadThemes`).
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

export const ThemeSchema = z.strictObject({
  label: z.string().min(1),
  /** Liquid in wall pockets and floor pits (null: none). */
  pools: z
    .strictObject({
      /** 0 lava, 1 water (frozen lakes), 2 water, 3 miasma: the renderer's liquid. */
      mode: z.number().int().min(0).max(3),
      /** Share of single-floor-neighbour wall cells turned into liquid pockets. */
      amount: z.number().min(0).max(1),
      /** Liquid pits per combat/elite room, at most. */
      pits: z.number().int().min(0).default(0),
    })
    .nullable()
    .default(null),
  /** Frozen lakes in large combat rooms. */
  lakes: z.boolean().default(false),
  icicles: z.boolean().default(false),
  /** Graveyard rooms (gravestones, a sarcophagus, candles). */
  graveyards: z.boolean().default(false),
  bones: z.boolean().default(false),
  /** Roots breaching the walls, moss around them and along walls. */
  roots: z.boolean().default(false),
  /** Name pools: "The <A> <B> of <syllables>". */
  nameA: z.array(z.string().min(1)).min(1),
  nameB: z.array(z.string().min(1)).min(1),
  /** Renderer data (palette, lights, particles, torch colour); not read by the generator. */
  look: z.record(z.string(), z.unknown()).default({}),
});

export type Theme = z.infer<typeof ThemeSchema>;
export type Themes = Record<string, Theme>;

export const BUILTIN_THEMES: Themes = {
  ancient: {
    label: "ANCIENT",
    pools: null,
    lakes: false, icicles: false, graveyards: false, bones: false, roots: false,
    nameA: ["Sunken", "Forgotten", "Silent", "Hollow", "Elder", "Broken", "Nameless", "Fallen"],
    nameB: ["Halls", "Vaults", "Catacombs", "Depths", "Sanctum", "Undercroft", "Barrows", "Reliquary"],
    look: {
      accent: "#e8973f", bg: 0x07080d, fog: 0x07080d, fogDensity: 0.0021,
      hemi: [0x2e3a52, 0x0a0b10, 0.55], dir: [0xffe8c8, 0.85],
      floor: 0x8a8f9c, corridor: 0x6d7380, wall: 0x5c626e, cap: 0x757b88, pillar: 0x6a707e, debris: [0x4c515e, 0x60584a],
      flame: 0xffa640, flameCore: 0xfff3c8, torchLight: [0xff8c3a, 1.5, 9.5], cloth: 0x7d2c26,
      particles: { kind: "dust", color: 0xaab4cc, n: 110 },
    },
  },
  molten: {
    label: "MOLTEN",
    pools: { mode: 0, amount: 0.16, pits: 2 },
    lakes: false, icicles: false, graveyards: false, bones: false, roots: false,
    nameA: ["Molten", "Ashen", "Cindered", "Smouldering", "Charred", "Burning", "Ember", "Scorched"],
    nameB: ["Forges", "Furnaces", "Calderas", "Foundry", "Kilns", "Vents", "Crucible", "Depths"],
    look: {
      accent: "#ff8642", bg: 0x0c0605, fog: 0x1a0b04, fogDensity: 0.0028,
      hemi: [0x6b3419, 0x160503, 0.55], dir: [0xffd9b0, 0.5],
      floor: 0x7a685c, corridor: 0x614f44, wall: 0x503e34, cap: 0x6b5546, pillar: 0x5e4a3e, debris: [0x4a382e, 0x60462f],
      flame: 0xff8c26, flameCore: 0xffe9b0, torchLight: [0xff7326, 1.7, 10], cloth: 0x7d2416,
      liquid: { colA: 0x2b0d05, colB: 0xff5a1f, glow: 1.55 },
      particles: { kind: "embers", color: 0xffa050, n: 240 },
    },
  },
  frost: {
    label: "FROST",
    pools: { mode: 1, amount: 0, pits: 0 },
    lakes: true, icicles: true, graveyards: false, bones: false, roots: false,
    nameA: ["Frozen", "Rimebound", "Glacial", "Howling", "Pale", "Shivering", "Wintered", "Whitelocked"],
    nameB: ["Crypts", "Caverns", "Hollows", "Galleries", "Sepulchre", "Warrens", "Reaches", "Throat"],
    look: {
      accent: "#7fd4ff", bg: 0x060a12, fog: 0x0b1522, fogDensity: 0.0024,
      hemi: [0x3a5a80, 0x0a0e18, 0.5], dir: [0xcfe4ff, 0.82],
      floor: 0x93a0b2, corridor: 0x78848f, wall: 0x60708a, cap: 0x8194ac, pillar: 0x70809a, debris: [0x55617a, 0x6d7a90],
      flame: 0x86d9ff, flameCore: 0xe8f7ff, torchLight: [0x6fc4ff, 1.35, 9.5], cloth: 0x2b4d70,
      liquid: { colA: 0x4a86c0, colB: 0xbfe4ff, glow: 0.55 },
      particles: { kind: "snow", color: 0xdff0ff, n: 260 },
    },
  },
  grim: {
    label: "GRIM",
    pools: { mode: 3, amount: 0.05, pits: 1 },
    lakes: false, icicles: false, graveyards: true, bones: true, roots: false,
    nameA: ["Blighted", "Weeping", "Rotting", "Cursed", "Umbral", "Plagued", "Mournful", "Grim"],
    nameB: ["Necropolis", "Ossuary", "Tombs", "Charnels", "Graves", "Catacombs", "Morgue", "Crypts"],
    look: {
      accent: "#9fe66a", bg: 0x070a07, fog: 0x0a130a, fogDensity: 0.003,
      hemi: [0x2c4030, 0x070a06, 0.52], dir: [0xbfd8b0, 0.45],
      floor: 0x7c8276, corridor: 0x62685c, wall: 0x4f5549, cap: 0x666c5e, pillar: 0x5c6254, debris: [0x4a4f44, 0x5e5c48],
      flame: 0x8fe05a, flameCore: 0xe9ffd0, torchLight: [0x77d94a, 1.35, 9], cloth: 0x33461f,
      liquid: { colA: 0x0a1207, colB: 0x41602c, glow: 0.6 },
      particles: { kind: "spores", color: 0x9fe66a, n: 150 },
    },
  },
  verdant: {
    label: "VERDANT",
    pools: { mode: 2, amount: 0.05, pits: 1 },
    lakes: false, icicles: false, graveyards: false, bones: false, roots: true,
    nameA: ["Verdant", "Overgrown", "Sporebound", "Tangled", "Mossgrown", "Waking", "Feral", "Blooming"],
    nameB: ["Gardens", "Warrens", "Roots", "Conservatory", "Hollows", "Groves", "Cisterns", "Arbors"],
    look: {
      accent: "#59d68f", bg: 0x060c09, fog: 0x091510, fogDensity: 0.0023,
      hemi: [0x2f5a46, 0x08120c, 0.6], dir: [0xd8f0c8, 0.8],
      floor: 0x848e7e, corridor: 0x6a7560, wall: 0x556050, cap: 0x6e7a66, pillar: 0x606c5c, debris: [0x49543f, 0x5c644c],
      flame: 0x62e0a8, flameCore: 0xe6fff0, torchLight: [0x4ad98e, 1.3, 9], cloth: 0x1f5038,
      liquid: { colA: 0x0c3532, colB: 0x2fa38a, glow: 0.6 },
      lightShafts: true,
      particles: { kind: "wisps", color: 0x8fe6b8, n: 200 },
    },
  },
};

/**
 * The built-in themes with a game's file merged over them: `{ "<id>": theme,
 * ... }`, each a full theme (a same-named one replaces the built-in).
 * Throws with every problem listed.
 */
export function loadThemes(file?: string): Themes {
  if (!file) return { ...BUILTIN_THEMES };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  const parsed = z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), ThemeSchema).safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${file}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return { ...BUILTIN_THEMES, ...parsed.data };
}

/** The theme for a seed when none is chosen ("auto"): Dungeon Forge's pick, over the theme ids in order. */
export function autoTheme(seed: number, themes: Themes): string {
  const keys = Object.keys(themes);
  return keys[(Math.imul(seed ^ 0x9e37, 2654435761) >>> 0) % keys.length];
}
