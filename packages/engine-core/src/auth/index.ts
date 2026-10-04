/**
 * Auth module — credential store, password hashing, hello validation,
 * session tokens, and auth rate limiting (auth slice, 2026-09-27).
 *
 * The gateway depends on these; the sim never sees them (EDA: auth is a
 * gateway concern, like the session itself).
 */

export {
  CsvCredentialStore,
  DEFAULT_USERS_CSV_PATH,
  USERNAME_RE,
} from "./credentials.js";
export type {
  CredentialRecord,
  CredentialStore,
} from "./credentials.js";

export {
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
} from "./passwords.js";

export {
  AdminCommandSchema,
  HelloCredentialsSchema,
  HelloTokenSchema,
  RegisterSchema,
  parseHello,
} from "./schemas.js";
export type { AdminCommandPayload, HelloCredentials, HelloToken, RegisterPayload } from "./schemas.js";

export { SessionManager } from "./sessions.js";
export type { AuthSession, SessionManagerOptions, SessionStore } from "./sessions.js";
export { SqliteSessionStore } from "./sqlite-session-store.js";

export { AuthRateLimiter } from "./rate-limit.js";
export type { RateLimitOptions } from "./rate-limit.js";
