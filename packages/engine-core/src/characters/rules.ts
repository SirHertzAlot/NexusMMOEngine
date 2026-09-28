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
  buildCatalog,
  lookToJson,
  parseLook,
  validateLook,
  type CharacterLook,
  type ModularCatalog,
} from "@mmo-engine/art/character";

export { CHARACTER_NAME_RE };

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
 * JSON, or what is wrong with it.
 */
export function checkNewLook(
  catalog: ModularCatalog | null,
  raw: unknown,
): { look: CharacterLook; json: string } | { problems: string[] } {
  const look = parseLook(raw);
  if (!look) return { problems: ["look: not a look"] };
  const names = Object.values(look.parts).filter((n): n is string => typeof n === "string");
  const problems = validateLook(catalog ?? buildCatalog(names).catalog, look, { creation: true });
  if (problems.length > 0) return { problems: problems.map((p) => `${p.field}: ${p.message}`) };
  return { look, json: lookToJson(look) };
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
