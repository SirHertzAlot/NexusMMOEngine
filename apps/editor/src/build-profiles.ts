/**
 * Build profile files (EA19): `content/build/profiles/<name>.json`, one
 * profile each, in the `@mmo-engine/build` format. Saving validates first
 * (shape, name, inputs inside the repo and present) and a refused save
 * writes nothing. The built-in `default` profile is code, not a file, and
 * can be neither replaced nor deleted.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { loadProfile, type BuildProfile } from "@mmo-engine/build";

export const BUILTIN_PROFILE = "default";
export const PROFILE_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export const profilesDir = (repoRoot: string): string => join(repoRoot, "content", "build", "profiles");

export class ProfileError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid build profile: ${issues.join("; ")}`);
  }
}

/** The validated profile, or every problem with the document. */
export function checkProfile(repoRoot: string, raw: unknown): { profile: BuildProfile } | { issues: string[] } {
  let profile: BuildProfile;
  try {
    profile = loadProfile(raw);
  } catch (e) {
    const zod = (e as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues;
    return { issues: zod ? zod.map((i) => `${i.path.join(".") || "profile"}: ${i.message}`) : [e instanceof Error ? e.message : String(e)] };
  }
  const issues: string[] = [];
  if (!PROFILE_NAME.test(profile.name)) issues.push("name: lowercase letters, digits and dashes, starting with a letter (40 at most)");
  if (profile.name === BUILTIN_PROFILE) issues.push(`name: "${BUILTIN_PROFILE}" is the built-in pipeline`);
  const root = resolve(repoRoot);
  profile.stages.forEach((s, i) => {
    s.inputs.forEach((input, j) => {
      const at = `stages[${i}].inputs[${j}]`;
      const abs = resolve(root, input);
      if (isAbsolute(input) || normalize(abs) !== abs || !(abs + sep).startsWith(root + sep)) issues.push(`${at}: "${input}" must be a path inside the repo`);
      else if (!existsSync(abs)) issues.push(`${at}: "${input}" does not exist`);
    });
  });
  return issues.length > 0 ? { issues } : { profile };
}

/** Validate and write a profile file; throws ProfileError (nothing written) when invalid. */
export function saveProfileFile(repoRoot: string, raw: unknown): BuildProfile {
  const r = checkProfile(repoRoot, raw);
  if ("issues" in r) throw new ProfileError(r.issues);
  const dir = profilesDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${r.profile.name}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(r.profile, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return r.profile;
}

/** Delete a profile file; false when there was none. */
export function deleteProfileFile(repoRoot: string, name: string): boolean {
  if (name === BUILTIN_PROFILE) throw new ProfileError([`"${BUILTIN_PROFILE}" is the built-in pipeline and cannot be deleted`]);
  if (!PROFILE_NAME.test(name)) throw new ProfileError(["name: not a profile name"]);
  const file = join(profilesDir(repoRoot), `${name}.json`);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
