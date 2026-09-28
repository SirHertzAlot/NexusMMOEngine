/**
 * Password hashing — argon2id (decided 2026-09-27, architecture brief §8).
 *
 * The CSV credential store holds ONLY hashes, never plaintext. Verification
 * is constant-time via argon2.verify (it compares the recomputed hash, not
 * the password bytes). A malformed stored hash is treated as "no match",
 * never as an exception escaping into the gateway.
 *
 * DUMMY_HASH: a fixed, valid argon2id hash used for the unknown-user path.
 * Verifying against it keeps the timing of "unknown user" indistinguishable
 * from "wrong password", closing a user-enumeration side channel. It is
 * not a credential for any account.
 */

import argon2 from "argon2";

/** Fixed argon2id hash — timing ballast for the unknown-user path only. */
export const DUMMY_HASH =
  "$argon2id$v=19$m=65536,p=4,t=3$VQzp0SMI8OioduWVOa8bXQ$1h/lDYq9F0xnXrc4AiwdFJlPCWLm3zFTI6D5bK4wWnc";

/** Hash a plaintext password with argon2id. Never log or store the input. */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/**
 * Constant-time password check. Returns false (never throws) when the
 * stored hash is malformed — a corrupt row must not crash auth.
 */
export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
