/** Browser adapter for the content-browser file routes (files-host.ts). */

export type OwnedKind = "scene" | "playtest" | "build";

async function call(method: string, path: string, body?: unknown): Promise<{ names?: string[]; name?: string }> {
  const res = await fetch(`/api/editor/files/${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string; names?: string[]; name?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

const enc = encodeURIComponent;

/** New document of `kind` from its template; the host refuses kinds with no template and names that already exist (409). */
export const createOwned = async (kind: OwnedKind, name: string): Promise<void> => void (await call("POST", kind, { name }));
export const listOwned = async (kind: OwnedKind): Promise<string[]> => (await call("GET", kind)).names ?? [];
export const renameOwned = async (kind: OwnedKind, name: string, to: string): Promise<void> => void (await call("POST", `${kind}/${enc(name)}/rename`, { to }));
export const duplicateOwned = async (kind: OwnedKind, name: string): Promise<string> => (await call("POST", `${kind}/${enc(name)}/duplicate`, {})).name ?? name;
export const deleteOwned = async (kind: OwnedKind, name: string): Promise<void> => void (await call("DELETE", `${kind}/${enc(name)}`));
