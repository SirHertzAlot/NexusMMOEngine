/**
 * The crafting rules as data: `content/crafting/recipes.json`.
 *
 * Recipes are derived from composed items (recipes.ts); what the derivation
 * is made of lives here, so a designer changes a cost in the editor and the
 * server and `craft:report` both see it:
 *
 *  - refining: each composer material component -> the raw materials one unit
 *    of it is refined from
 *  - reagents: the reagent an element's enchantments take, and what an
 *    ability of that element takes on top
 *  - fittings: raw materials a base adds by its tags (hide on armour, a gold
 *    setting on jewellery)
 *  - units: how many units of its material a base takes, by its tags
 *  - skills: the craft skill by base tag
 *
 * `checkCraftingRules` checks the file against the materials (every input is a
 * known raw material), the composer catalog (every material component has a
 * refining row) and itself.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BUILTIN_CATALOG, type Catalog } from "@mmo-engine/compose/browser";
import { BUILTIN_MATERIALS, type Material } from "./materials.js";

const id = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase id (a-z, 0-9, -)");
const tags = z.array(id).min(1);
const amounts = z.record(id, z.number().int().min(1));

export const CraftingRulesSchema = z.strictObject({
  version: z.literal(1),
  /** Composer material component -> raw materials per unit of it. */
  refining: z.record(id, z.strictObject({ inputs: amounts.refine((m) => Object.keys(m).length > 0, "needs at least one input") })),
  /** Element -> its reagent, and what an ability of that element also takes. */
  reagents: z.record(id, z.strictObject({ reagent: id, extra: id.optional() })),
  /** Reagent when an affix, ability or aura has no element. */
  fallbackReagent: id,
  /** Rune stone: carved runes take one, a unique ability three. */
  runeStone: id,
  /** Raw materials added whole (not per unit) to a base with any of the tags. */
  fittings: z.array(z.strictObject({ tags, add: amounts })),
  /** Units of material a base takes: the first row with any of its tags wins. */
  units: z.array(z.strictObject({ tags, units: z.number().int().min(1) })),
  defaultUnits: z.number().int().min(1),
  /** Craft skill: the first row with any of the base's tags wins. */
  skills: z.array(z.strictObject({ tags, skill: z.string().min(1) })),
  defaultSkill: z.string().min(1),
});
export type CraftingRules = z.infer<typeof CraftingRulesSchema>;

/** The repo's content/crafting/recipes.json (this file is dist/src/rules.js). */
export const DEFAULT_CRAFTING_FILE = fileURLToPath(new URL("../../../../content/crafting/recipes.json", import.meta.url));

export interface CraftingIssue {
  path: string;
  message: string;
}

/** Every problem with `json` as crafting rules: shape first, then references. Empty: fine. */
export function checkCraftingRules(
  json: unknown,
  o: { materials?: Record<string, Material>; catalog?: Catalog } = {},
): CraftingIssue[] {
  const parsed = CraftingRulesSchema.safeParse(json);
  if (!parsed.success) return parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  const r = parsed.data;
  const materials = o.materials ?? BUILTIN_MATERIALS;
  const catalog = o.catalog ?? BUILTIN_CATALOG;
  const out: CraftingIssue[] = [];
  const raw = (path: string, m: string): void => {
    if (!materials[m]) out.push({ path, message: `"${m}" is not a known raw material` });
  };
  for (const [mat, row] of Object.entries(r.refining)) for (const m of Object.keys(row.inputs)) raw(`refining.${mat}.inputs.${m}`, m);
  for (const [comp, c] of Object.entries(catalog.components)) {
    if (c.slot === "material" && !r.refining[comp]) out.push({ path: `refining.${comp}`, message: `composer material "${comp}" has no refining recipe` });
  }
  for (const k of Object.keys(r.refining)) {
    const c = catalog.components[k];
    if (!c || c.slot !== "material") out.push({ path: `refining.${k}`, message: `"${k}" is not a composer material component` });
  }
  for (const [el, row] of Object.entries(r.reagents)) {
    raw(`reagents.${el}.reagent`, row.reagent);
    if (row.extra) raw(`reagents.${el}.extra`, row.extra);
  }
  raw("fallbackReagent", r.fallbackReagent);
  raw("runeStone", r.runeStone);
  r.fittings.forEach((f, i) => Object.keys(f.add).forEach((m) => raw(`fittings[${i}].add.${m}`, m)));
  return out;
}

export class CraftingRulesError extends Error {
  constructor(
    readonly file: string,
    readonly issues: CraftingIssue[],
  ) {
    super(`${file}:\n${issues.map((i) => `  ${i.path || "(file)"}: ${i.message}`).join("\n")}`);
    this.name = "CraftingRulesError";
  }
}

/** Read and check a crafting rules file. Throws CraftingRulesError listing every problem. */
export function loadCraftingRules(file: string = DEFAULT_CRAFTING_FILE, o: Parameters<typeof checkCraftingRules>[1] = {}): CraftingRules {
  if (!existsSync(file)) throw new CraftingRulesError(file, [{ path: "", message: "no such file" }]);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new CraftingRulesError(file, [{ path: "", message: `not valid JSON: ${(e as Error).message}` }]);
  }
  const issues = checkCraftingRules(json, o);
  if (issues.length > 0) throw new CraftingRulesError(file, issues);
  return CraftingRulesSchema.parse(json);
}
