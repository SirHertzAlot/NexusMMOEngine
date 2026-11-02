/**
 * WorldCredentialStore — accounts on the world server (slice C).
 *
 * The region's gateway signs players in against the world's `account`
 * table: a username and its argon2id hash, shared by every region. The
 * region keeps a positive cache (an account's hash never changes once
 * created, so a cached hit can't go stale) and never caches a miss.
 *
 * An optional fallback (the region's users.csv) lets accounts that
 * predate the move keep working: a sign-in the world doesn't know is
 * looked up in the CSV, and a hit is copied to the world, so the next
 * sign-in finds it there. Creation goes to the world only.
 */

import type { CredentialRecord, CredentialStore } from "./credentials.js";
import { WorldTransportError, type WorldClient } from "../world/client.js";

export type WorldAccountClient = Pick<WorldClient, "getAccount" | "createAccount">;

export class WorldCredentialStore implements CredentialStore {
  private readonly cache = new Map<string, CredentialRecord>();

  constructor(
    private readonly client: WorldAccountClient,
    private readonly fallback?: CredentialStore,
  ) {}

  async findUser(username: string): Promise<CredentialRecord | null> {
    const hit = this.cache.get(username);
    if (hit !== undefined) return hit;
    const remote = await this.client.getAccount(username);
    if (remote !== null) {
      const rec = { username: remote.username, passwordHash: remote.passwordHash };
      this.cache.set(username, rec);
      return rec;
    }
    const local = this.fallback ? await this.fallback.findUser(username) : null;
    if (local === null) return null;
    // Copy a CSV-only account to the world. A concurrent copy (409) means
    // the world has it now, so it is still a hit.
    try {
      await this.client.createAccount(local.username, local.passwordHash);
    } catch (err) {
      if (!(err instanceof WorldTransportError && err.code === 409)) throw err;
    }
    this.cache.set(username, local);
    return local;
  }

  async createUser(username: string, passwordHash: string): Promise<void> {
    try {
      const created = await this.client.createAccount(username, passwordHash);
      this.cache.set(username, { username: created.username, passwordHash: created.passwordHash });
    } catch (err) {
      if (err instanceof WorldTransportError && err.code === 409) {
        throw new Error(`credential-store: user ${JSON.stringify(username)} already exists`);
      }
      throw err;
    }
  }
}
