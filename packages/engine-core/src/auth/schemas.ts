/**
 * Zod schemas for auth payloads (auth slice, 2026-09-27).
 *
 * Zod is INPUT VALIDATION, not authentication: these schemas check shape,
 * lengths, and formats before any credential logic runs. The real check
 * is argon2.verify (./passwords.ts); the real identity is the opaque
 * session token (./sessions.ts).
 *
 * `hello` has three variants (docs/MESSAGE-CATALOG.md):
 * - credentials: { username, password }  — first contact / login
 * - token:       { token }               — reconnect with a session token
 * - migration:   { migration, ticket }   — arrive from another region
 *   (WORLD-SERVER-SPEC §6), with the ticket the source region handed out
 * A payload carrying more than one (or none) is malformed. Both schemas are
 * .strict(): unknown fields are rejected, so a client can't smuggle
 * extra auth material past validation.
 */

import { z } from "zod";
import { USERNAME_RE } from "./credentials.js";

const helloBase = z.object({
  protocol: z.number().int(),
  client: z.string().min(1).max(64),
  want_snapshot: z.boolean(),
  // Choose a character before entering the world (catalog §0x0c).
  characters: z.boolean().optional(),
});

/** First contact: prove who you are with a password. */
export const HelloCredentialsSchema = helloBase
  .extend({
    username: z.string().regex(USERNAME_RE),
    password: z.string().min(8).max(128),
  })
  .strict();

/** Reconnect: present the opaque session token from a previous welcome. */
export const HelloTokenSchema = helloBase
  .extend({
    // Our tokens are 64 lowercase hex chars (crypto.randomBytes(32)).
    token: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** Arrive from another region: the world's migration id and the source's one-time ticket. */
export const HelloMigrationSchema = helloBase
  .extend({
    migration: z.string().regex(/^mig-[0-9a-f]{24}$/),
    ticket: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** Observe a neighbour's border (IM8): the home region's ticket, no player. */
export const HelloObserveSchema = helloBase
  .extend({
    observe: z.strictObject({
      region: z.string().min(1).max(128),
      from: z.string().min(1).max(128),
      account: z.string().min(1).max(64),
      exp: z.number().int(),
      ticket: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  })
  .strict();

export type HelloObserve = z.infer<typeof HelloObserveSchema>;
export type HelloCredentials = z.infer<typeof HelloCredentialsSchema>;
export type HelloToken = z.infer<typeof HelloTokenSchema>;
export type HelloMigration = z.infer<typeof HelloMigrationSchema>;

/**
 * In-client account creation (protocol 0x0b). Same shape discipline as
 * the credentials hello: strict, lengths bounded, username charset
 * shared with the credential store. The password is hashed with
 * argon2id by the gateway before it touches the store — it is never
 * persisted or logged in plaintext.
 */
export const RegisterSchema = z
  .object({
    protocol: z.number().int(),
    client: z.string().min(1).max(64),
    username: z.string().regex(USERNAME_RE),
    password: z.string().min(8).max(128),
    characters: z.boolean().optional(),
  })
  .strict();

export type RegisterPayload = z.infer<typeof RegisterSchema>;

/**
 * Admin console command (protocol 0x10, roadmap A1). Strict like every
 * control payload: exactly `{kind: "admin", command}` plus optional
 * per-command args. Command names are lowercase letters (A2+ adds its
 * commands here, each with its own args schema).
 */
export const AdminCommandSchema = z
  .object({
    kind: z.literal("admin"),
    command: z.string().regex(/^[a-z]{1,32}$/),
    args: z.unknown().optional(),
  })
  .strict();

export type AdminCommandPayload = z.infer<typeof AdminCommandSchema>;

/**
 * Parse a decoded-JSON hello into its variant. Returns null when the
 * payload matches neither variant (malformed hello -> error 4003).
 */
export function parseHello(
  raw: unknown,
):
  | { kind: "credentials"; value: HelloCredentials }
  | { kind: "token"; value: HelloToken }
  | { kind: "migration"; value: HelloMigration }
  | { kind: "observe"; value: HelloObserve }
  | null {
  const creds = HelloCredentialsSchema.safeParse(raw);
  if (creds.success) return { kind: "credentials", value: creds.data };
  const tok = HelloTokenSchema.safeParse(raw);
  if (tok.success) return { kind: "token", value: tok.data };
  const mig = HelloMigrationSchema.safeParse(raw);
  if (mig.success) return { kind: "migration", value: mig.data };
  const obs = HelloObserveSchema.safeParse(raw);
  if (obs.success) return { kind: "observe", value: obs.data };
  return null;
}
