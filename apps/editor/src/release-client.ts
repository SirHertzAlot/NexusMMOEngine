/** Browser-safe client of the Release routes (EA19, release-host.ts). */
import type { BuildProfile, PackageManifest, RunRecord } from "./release-model.js";
import type { Health, TargetState } from "./release-targets.js";

type Body = Record<string, unknown>;

async function call<T = Body>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/editor/release/${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const b = (await res.json().catch(() => ({}))) as Body & { error?: string; issues?: string[] };
  // A failed deploy still carries its result; every other refusal is an error with its problems.
  if (!res.ok && !(path.startsWith("deploy") || path.startsWith("rollback"))) {
    throw new Error([b.error ?? `HTTP ${res.status}`, ...(b.issues ?? [])].join("; "));
  }
  return b as T;
}

export interface ProfileEntry {
  name: string;
  profile: BuildProfile | null;
  issues: string[];
  cached: string[];
}
export interface DeployReply {
  ok: boolean;
  live: string | null;
  rolledBack?: boolean;
  error?: string;
  health?: Health;
}

export const releaseApi = {
  profiles: () => call<{ profiles: ProfileEntry[] }>("GET", "profiles").then((b) => b.profiles),
  saveProfile: (name: string, content: unknown) => call("PUT", `profiles/${name}`, { content }),
  deleteProfile: (name: string) => call("DELETE", `profiles/${name}`),
  run: (profile: string, force: boolean) => call<{ id: number }>("POST", "run", { profile, force }).then((b) => b.id),
  cancel: () => call("POST", "cancel", {}),
  runs: () => call<{ runs: RunRecord[]; active: number | null }>("GET", "runs"),
  getRun: (id: number) => call<{ run: RunRecord; active: boolean }>("GET", `runs/${id}`),
  packages: () => call<{ packages: PackageManifest[] }>("GET", "packages").then((b) => b.packages),
  target: () => call<{ state: TargetState; health: Health | null; current: PackageManifest | null }>("GET", "target"),
  diff: (pkg: string) => call<{ changes: string[] }>("GET", `diff/${pkg}`).then((b) => b.changes),
  deploy: (pkg: string) => call<DeployReply>("POST", "deploy", { package: pkg }),
  rollback: (to?: string) => call<DeployReply>("POST", "rollback", to ? { to } : {}),
  stop: () => call("POST", "target/stop", {}),
};
