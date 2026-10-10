/**
 * EA22 foundation: materials as data (`content/materials/*.json`).
 *
 * Toon and surface (PBR) material definitions. The client builds three.js
 * materials from these; tuning a material is a JSON edit, never code.
 */
import { z } from "zod";

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be #rrggbb");

export const Material = z.discriminatedUnion("kind", [
  z.object({
    name: z.string().min(1),
    kind: z.literal("toon"),
    color: HexColor,
    /** Toon shading steps (2 = harsh, 5 = soft). */
    steps: z.number().int().min(2).max(8).default(3),
    outline: z.object({
      color: HexColor,
      width: z.number().min(0).max(0.1),
    }).optional(),
  }),
  z.object({
    name: z.string().min(1),
    kind: z.literal("surface"),
    color: HexColor,
    metalness: z.number().min(0).max(1).default(0),
    roughness: z.number().min(0).max(1).default(1),
    emissive: HexColor.optional(),
  }),
]);

export type Material = z.infer<typeof Material>;

/** Parse and validate a material from JSON (throws on invalid). */
export function loadMaterial(json: unknown): Material {
  return Material.parse(json);
}
