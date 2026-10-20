/**
 * The crafting rules form (roadmap EG3, Gameplay › Crafting): what
 * content/crafting/recipes.json says beyond refining and reagents (those are
 * the Data grids'), as field specs for the spec-form pieces. Browser-safe.
 *
 * The three row lists are ordered: a base takes the first row with any of
 * its tags, so the form keeps their order and lets a designer move rows.
 */

import type { FieldSectionSpec, FieldSpec } from "./rules-control.js";

const tags: FieldSpec = { key: "tags", label: "Base tags", kind: "list", help: "Any of these tags on a base matches (comma-separated)." };

export const CRAFTING_SECTIONS: readonly FieldSectionSpec[] = [
  {
    title: "Defaults and special materials",
    help: "What a base takes when no row below matches, and the materials every enchanted item draws on.",
    fields: [
      { key: "defaultUnits", label: "Default units of material", kind: "number", int: true, min: 1, help: "Units of its material a base takes when no Units row matches." },
      { key: "defaultSkill", label: "Default craft skill", kind: "text", help: "The skill that crafts a base no Skills row matches." },
      { key: "fallbackReagent", label: "Fallback reagent", kind: "enum", options: "materials", help: "Reagent for an affix, ability or aura with no element." },
      { key: "runeStone", label: "Rune stone", kind: "enum", options: "materials", help: "Carved runes take one, a unique ability three." },
    ],
  },
];

/** One ordered list of rows on the form. */
export interface RowListSpec {
  under: string;
  title: string;
  help: string;
  noun: string;
  fields: readonly FieldSpec[];
  newRow: () => Record<string, unknown>;
}

export const CRAFTING_ROWS: readonly RowListSpec[] = [
  {
    under: "units",
    title: "Units",
    help: "How many units of its material a base takes. The first row with any of the base's tags wins.",
    noun: "units row",
    fields: [tags, { key: "units", label: "Units", kind: "number", int: true, min: 1 }],
    newRow: () => ({ tags: [], units: 3 }),
  },
  {
    under: "fittings",
    title: "Fittings",
    help: "Raw materials added whole (not per unit) to a base with any of the tags. Every matching row adds.",
    noun: "fitting",
    fields: [tags, { key: "add", label: "Adds (material: amount)", kind: "map", help: "e.g. beast-hide: 2, gold-ore: 1" }],
    newRow: () => ({ tags: [], add: {} }),
  },
  {
    under: "skills",
    title: "Skills",
    help: "The craft skill a base trains. The first row with any of the base's tags wins.",
    noun: "skill row",
    fields: [tags, { key: "skill", label: "Skill", kind: "text" }],
    newRow: () => ({ tags: [], skill: "" }),
  },
];
