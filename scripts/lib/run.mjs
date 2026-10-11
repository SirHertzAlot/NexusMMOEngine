/**
 * Shared by the root scripts (start.mjs, build.mjs): run a command in the
 * foreground from the repo root (or a given folder) and stop with its exit
 * code if it fails. Plain Node, so it behaves the same on Windows, macOS and
 * Linux; `npm` is npm.cmd on Windows, which needs a shell.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const win = process.platform === "win32";

/** Run `cmd args` and return its exit status (stdout and stderr go to the terminal). */
export function run(cmd, args, { cwd = root, env = {} } = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: win, env: { ...process.env, ...env } });
  return r.status ?? 1;
}

/** Run an npm command; on failure print `hint` and the failing command (under `name`'s prefix), then exit. */
export function npm(name, npmArgs, { env = {}, hint = "", again = "" } = {}) {
  console.log(`[${name}] npm ${npmArgs.join(" ")}`);
  const status = run("npm", npmArgs, { env });
  if (status !== 0) {
    if (hint) console.error(`[${name}] ${hint}`);
    console.error(`[${name}] npm ${npmArgs.join(" ")} failed (${status})${again ? `; ${again}` : ""}`);
    process.exit(status);
  }
}
