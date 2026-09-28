/**
 * Zod schemas for auth payloads (auth slice, 2026-09-27).
 *
 * Zod is INPUT VALIDATION, not authentication: these schemas check shape,
 * lengths, and formats before any credential logic runs. The real check
 * is argon2.verify (./passwords.ts); the real identity is the opaque
 * session token (./sessions.ts).
 *
 * `hello` has two variants (docs/MESSAGE-CATALOG.md):
 * - credentials: { username, password } — first contact / login
 * - token:       { token }             — reconnect with a session token
 * A payload carrying BOTH (or neither) is malformed. Both schemas are
 * .strict(): unknown fields are rejected, so a client can't smuggle
 * extra auth material past validation.
 */

import { z } from "zod";
import { USERNAME_RE } from "./credentials.js";

const helloBase = z.object({
  protocol: z.number().int(),
  client: z.string().min(1).max(64),
  want_snapshot: z.boolean(),
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

export type HelloCredentials = z.infer<typeof HelloCredentialsSchema>;
export type HelloToken = z.infer<typeof HelloTokenSchema>;

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
  })
  .strict();

export type RegisterPayload = z.infer<typeof RegisterSchema>;

/**
 * Parse a decoded-JSON hello into its variant. Returns null when the
 * payload matches neither variant (malformed hello -> error 4003).
 */
export function parseHello(
  raw: unknown,
): { kind: "credentials"; value: HelloCredentials } | { kind: "token"; value: HelloToken } | null {
  const creds = HelloCredentialsSchema.safeParse(raw);
  if (creds.success) return { kind: "credentials", value: creds.data };
  const tok = HelloTokenSchema.safeParse(raw);
  if (tok.success) return { kind: "token", value: tok.data };
  return null;
}
