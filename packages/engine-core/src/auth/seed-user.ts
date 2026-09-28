/**
 * Seed a dev user into the CSV credential store (auth slice).
 *
 * Runnable (from packages/engine-core, after `npm run build`):
 *   MMO_DEV_PASSWORD='<password>' npm run seed:user -- <username> [--csv <path>]
 *
 * - The password comes ONLY from the MMO_DEV_PASSWORD environment
 *   variable: never from CLI args (which leak into shell history), and
 *   never generated-and-printed (which leaks into terminal scrollback).
 * - It is validated (8-128 chars) and hashed with argon2id before it
 *   touches the store; plaintext never lands in the CSV, and the
 *   password/hash are never printed or logged anywhere.
 * - Safe to re-run: an existing username is reported, not duplicated.
 */

import { CsvCredentialStore } from "./credentials.js";
import { hashPassword } from "./passwords.js";

function usage(): never {
  console.error(
    "usage: MMO_DEV_PASSWORD='<password>' seed-user.js <username> [--csv <path>]",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let csvPath: string | undefined;
  const csvFlag = args.indexOf("--csv");
  if (csvFlag >= 0) {
    csvPath = args[csvFlag + 1];
    if (!csvPath) usage();
    args.splice(csvFlag, 2);
  }
  const [username] = args;
  if (!username) usage();

  const password = process.env["MMO_DEV_PASSWORD"];
  if (!password || password.length < 8 || password.length > 128) {
    console.error(
      "seed-user: set MMO_DEV_PASSWORD to a password of 8-128 characters",
    );
    process.exit(2);
  }

  const store = new CsvCredentialStore(csvPath ?? "./data/users.csv");
  if (await store.findUser(username)) {
    console.log(
      `user ${JSON.stringify(username)} already exists — nothing to do`,
    );
    return;
  }
  await store.createUser(username, await hashPassword(password));
  // Only the username is reported. The password and hash are never printed.
  console.log(`created user ${JSON.stringify(username)} in ${store.path}`);
}

main().catch((err) => {
  console.error(`seed-user: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
