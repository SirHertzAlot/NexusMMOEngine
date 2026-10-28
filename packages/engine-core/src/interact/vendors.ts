/**
 * Vendor templates from content (IX8): content/vendors.json says what a shop sells, by item base
 * (and rank, default the lowest) and price; a scene node with a `Vendor` component names one and
 * the shop is open for whoever walks up and presses E. Resolved to item definitions when first
 * attached, once the item pool exists.
 */

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const VendorTemplateSchema = z.object({
  name: z.string().min(1),
  buybackRate: z.number().min(0).max(1).default(0.3),
  stock: z.array(z.object({
    base: z.string().min(1),
    rank: z.string().min(1).optional(),
    price: z.number().int().min(1),
    /** Units for sale; -1 is infinite. */
    quantity: z.number().int().refine((q) => q !== 0, "quantity 0 sells nothing").default(-1),
  })),
});
export type VendorTemplate = z.infer<typeof VendorTemplateSchema>;

const VendorsFileSchema = z.object({
  version: z.literal(1, "unsupported vendors version"),
  vendors: z.record(z.string(), VendorTemplateSchema),
  /** The template a resident shopkeeper sells from, by the archetype of the shop they keep ("*": any other). */
  byArchetype: z.record(z.string(), z.string()).default({}),
});

/** The vendor templates in `file` (absent file: none). Throws on a bad file, naming what is wrong. */
export function loadVendorTemplates(file: string): Map<string, VendorTemplate> {
  return loadVendors(file).templates;
}

/** The templates and the shopkeeper-archetype table. */
export function loadVendors(file: string): { templates: Map<string, VendorTemplate>; byArchetype: Record<string, string> } {
  if (!existsSync(file)) return { templates: new Map(), byArchetype: {} };
  const parsed = VendorsFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return { templates: new Map(Object.entries(parsed.data.vendors)), byArchetype: parsed.data.byArchetype };
}
