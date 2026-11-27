/**
 * Character rules on the server: what a create_character / enter_world
 * message may carry, what a new character's look may be, and the part
 * catalog looks are checked against.
 *
 * The catalog is the modular pack's (catalog.json, written by
 * `npm run convert:modular -w @mmo-engine/art` next to the converted
 * parts). The art is licensed and lives only on machines that have it;
 * a server without it still checks looks structurally — each part name
 * must be a well-formed pack name for its slot and gender, and the body
 * the starter armour — it just can't tell whether the part exists.
 */

import * as fs from "node:fs";
import { z } from "zod";
import { CHARACTER_NAME_RE } from "@mmo-engine/protocol";
import {
  DEFAULT_CREATION_RULES,
  buildCatalog,
  creationLookProblems,
  lookToJson,
  parseCreationRules,
  parseLook,
  validateLook,
  type CharacterLook,
  type CreationRules,
  type ModularCatalog,
} from "@mmo-engine/art/character";

export { CHARACTER_NAME_RE };

/** Characters an account may hold when nothing says otherwise (social.json's characters.slots does). */
export const DEFAULT_MAX_CHARACTERS = 8;

/** Largest create_character payload accepted (a full look is ~0.5 KB). */
export const MAX_CREATE_PAYLOAD_BYTES = 4096;

/** The look of a player who joins without choosing a character. */
export const DEFAULT_LOOK_JSON = lookToJson({ gender: "male", parts: {}, colours: {} });

export const CreateCharacterSchema = z
  .object({
    name: z.string().regex(CHARACTER_NAME_RE),
    look: z.unknown(),
  })
  .strict();

export const EnterWorldSchema = z
  .object({
    character: z.number().int().positive(),
  })
  .strict();

/**
 * A new character's look, checked for creation: its canonical form and
 * JSON, or what is wrong with it. Two questions, both asked: could a
 * character look like this at all (the catalog), and may a player choose
 * it when creating one (this game's creation rules).
 */
export function checkNewLook(
  catalog: ModularCatalog | null,
  raw: unknown,
  rules: CreationRules = DEFAULT_CREATION_RULES,
): { look: CharacterLook; json: string } | { problems: string[] } {
  const look = parseLook(raw);
  if (!look) return { problems: ["look: not a look"] };
  const names = Object.values(look.parts).filter((n): n is string => typeof n === "string");
  const resolved = catalog ?? buildCatalog(names).catalog;
  const problems = [...validateLook(resolved, look), ...creationLookProblems(resolved, look, rules)];
  if (problems.length > 0) return { problems: problems.map((p) => `${p.field}: ${p.message}`) };
  return { look, json: lookToJson(look) };
}

/**
 * The game's creation rules at `file`, or the engine's defaults when
 * there is no file — which is the usual case, and not a problem: the
 * defaults are what the engine did before the file existed.
 *
 * A file that is there and wrong is a different matter. It is reported,
 * not silently ignored, because a game that wrote the file meant it; the
 * caller decides whether to boot with the defaults or stop.
 */
export function loadCreationRules(file: string): { rules: CreationRules; from: string | null; problems: string[] } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { rules: DEFAULT_CREATION_RULES, from: null, problems: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (e) {
    return { rules: DEFAULT_CREATION_RULES, from: file, problems: [`${file}: ${(e as Error).message}`] };
  }
  const parsed = parseCreationRules(raw);
  return "rules" in parsed
    ? { rules: parsed.rules, from: file, problems: [] }
    : { rules: DEFAULT_CREATION_RULES, from: file, problems: parsed.problems.map((p) => `${p.path || "(root)"}: ${p.message}`) };
}

/** The part catalog at `file`, or null when there is none (no art on this machine). */
export function loadCharacterCatalog(file: string): ModularCatalog | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const catalog = JSON.parse(text) as ModularCatalog;
  if (!Array.isArray(catalog.parts)) throw new Error(`character catalog ${file}: no parts`);
  return catalog;
}
