/**
 * Third-party credits (`content/credits.json`): the attribution the game's
 * entrance / credits screen must show for third-party art. Data only: the
 * screen is the client's. Browser-safe (no node imports).
 *
 *   import credits from "../../../content/credits.json";
 *   const { thirdPartyArt } = parseCredits(credits);
 *
 * An entry lists an author and a licence by name, never a model or file.
 * `confirmed: false` means the wording is still to be checked against the
 * licence (see `todo`).
 */
import { z } from "zod";

export const CreditEntrySchema = z.object({
  author: z.string().min(1),
  /** Where the author's work is published. */
  source: z.url(),
  /** Licence name as the pack states it. */
  licence: z.string().min(1),
  licenceUrl: z.url().optional(),
  /** The line the credits screen shows. */
  text: z.string().min(1),
  /** The wording has been checked against the licence. */
  confirmed: z.boolean(),
  todo: z.string().optional(),
}).strict();

export const CreditsSchema = z.object({
  version: z.literal(1),
  thirdPartyArt: z.array(CreditEntrySchema),
}).strict();

export type CreditEntry = z.infer<typeof CreditEntrySchema>;
export type Credits = z.infer<typeof CreditsSchema>;

export function parseCredits(json: unknown): Credits {
  return CreditsSchema.parse(json);
}
