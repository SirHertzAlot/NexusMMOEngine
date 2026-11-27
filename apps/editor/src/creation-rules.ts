/**
 * The character creation form (roadmap EB7): the field specs behind
 * Gameplay › Character creation, and the summary line that says what a
 * player will actually be offered.
 *
 * The document is `content/character-creation.json`, read by the server
 * (`loadCreationRules`) and by the client's character screen, so this
 * panel is the one place all three agree on. Browser-safe: the art
 * package's own lists decide what may be offered, not a copy of them.
 */

import { COLOUR_SLOTS, DETAIL_SLOTS, parseCreationRules, type CreationRules } from "@mmo-engine/art/browser";
import type { FieldSpec } from "./rules-control.js";

const GENDERS = ["male", "female"] as const;

/** The document's own fields, above the two row editors. */
export const CREATION_FIELDS: FieldSpec[] = [
  {
    key: "genders",
    label: "Genders",
    kind: "list",
    def: [...GENDERS],
    restart: true,
    help: "The pack has male and female parts; a game may offer one of them.",
  },
  {
    key: "lockBodyToStarter",
    label: "Body locked to the starter armour",
    kind: "bool",
    def: true,
    restart: true,
    help: "On: a new character wears the starter set and changes it in the world. Off: any body set may be chosen at creation.",
  },
];

/** One part category: a row in the picker column of the character screen. */
export const CREATION_PART_FIELDS: FieldSpec[] = [
  { key: "slot", label: "Slot", kind: "enum", options: [...DETAIL_SLOTS] },
  { key: "optional", label: "May be left empty", kind: "bool", def: true },
  { key: "gender", label: "Offered to", kind: "enum", options: [...GENDERS], optional: true },
];

/** One colour row: a swatch strip on the character screen. */
export const CREATION_COLOUR_FIELDS: FieldSpec[] = [
  { key: "slot", label: "Colour", kind: "enum", options: [...COLOUR_SLOTS] },
  { key: "swatches", label: "Swatches", kind: "list" },
  { key: "optional", label: "May be left unset", kind: "bool", def: true },
  { key: "gender", label: "Offered to", kind: "enum", options: [...GENDERS], optional: true },
];

export interface CreationSummary {
  /** One line per gender: what that player is offered. */
  lines: string[];
  /** What the document cannot say (empty: the engine would load it). */
  problems: string[];
}

const list = (xs: readonly string[]): string => (xs.length === 0 ? "nothing" : xs.join(", "));

/**
 * What the document in the form would give a player, read back through
 * the engine's own reader rather than off the form's state — so the
 * summary is what the server would do, not what the form meant.
 */
export function creationSummary(content: unknown): CreationSummary {
  const parsed = parseCreationRules(content);
  if ("problems" in parsed) {
    return { lines: [], problems: parsed.problems.map((p) => `${p.path || "(root)"}: ${p.message}`) };
  }
  const rules: CreationRules = parsed.rules;
  const lines = rules.genders.map((g) => {
    const parts = rules.parts.filter((p) => p.gender === undefined || p.gender === g).map((p) => p.slot);
    const colours = rules.colours.filter((c) => c.gender === undefined || c.gender === g).map((c) => c.slot);
    return `A ${g} character chooses ${list(parts)}, and colours ${list(colours)}.`;
  });
  lines.push(
    rules.lockBodyToStarter
      ? "The body is the starter armour; armour is chosen in the world, not here."
      : "Any body set may be chosen at creation.",
  );
  return { lines, problems: [] };
}
