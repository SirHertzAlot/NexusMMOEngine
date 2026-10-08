/**
 * Browser-safe module registry for the editor shell (roadmap EA3).
 *
 * The host (modules-host.ts) says which modules exist and which are
 * enabled; each enabled module with an editor entry is imported
 * dynamically (once) and contributes panels to workspaces. Disabling a
 * module drops its panels on the next refresh, no restart. Pure TS, no
 * React: a panel's `render` returns whatever the shell mounts.
 */

export interface ModuleInfo {
  name: string;
  version: string;
  description: string;
  dependsOn: string[];
  enabled: boolean;
  locked: boolean;
  editor: boolean;
  systems: string[];
}
export interface ModuleProblem {
  module: string;
  path: string;
  message: string;
}
export interface ModulesState {
  modules: ModuleInfo[];
  invalid: Array<{ name: string; problems: ModuleProblem[] }>;
  enabled: string[];
  problems: ModuleProblem[];
  /** The tick order the saved set resolves to; null when it does not resolve. */
  tickOrder: string[] | null;
  /** The running play server's tick order, null when none is running. */
  running: { systems: string[] } | null;
}

/** A panel a module adds to a workspace's center views. */
export interface EditorPanel {
  id: string;
  /** A workspace id of the shell ("characters", "scene", ...). */
  workspace: string;
  title: string;
  icon: string;
  render(): unknown;
}
/** What a module's `editor/index` exports. */
export interface EditorModuleEntry {
  panels?: EditorPanel[];
}
export type EntryLoader = () => Promise<EditorModuleEntry>;

/** Turn `import.meta.glob("…/modules/*\/editor/index.*")` into loaders keyed by module name. */
export function loadersFromGlob(glob: Record<string, () => Promise<unknown>>): Record<string, EntryLoader> {
  const out: Record<string, EntryLoader> = {};
  for (const [path, load] of Object.entries(glob)) {
    const m = /modules\/([^/]+)\/editor\//.exec(path.replace(/\\/g, "/"));
    if (m) out[m[1]] = load as EntryLoader;
  }
  return out;
}

export class ModuleRegistry {
  state: ModulesState | null = null;
  /** Bumped on every refresh: the snapshot for useSyncExternalStore. */
  version = 0;
  /** Module name -> why its entry did not load; "(host)" when the host was unreachable. */
  errors: Record<string, string> = {};
  private loaded = new Map<string, EditorModuleEntry>();
  private active: EditorPanel[] = [];
  private listeners = new Set<() => void>();

  constructor(
    private readonly loaders: Record<string, EntryLoader>,
    private readonly fetchState: () => Promise<ModulesState>,
  ) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  panels(workspace: string): EditorPanel[] {
    return this.active.filter((p) => p.workspace === workspace);
  }

  async refresh(): Promise<void> {
    const errors: Record<string, string> = {};
    try {
      this.state = await this.fetchState();
    } catch (e) {
      errors["(host)"] = e instanceof Error ? e.message : String(e);
    }
    const panels: EditorPanel[] = [];
    for (const m of this.state?.modules ?? []) {
      const load = this.loaders[m.name];
      if (!m.enabled || !m.editor || !load) continue;
      try {
        if (!this.loaded.has(m.name)) this.loaded.set(m.name, await load());
        panels.push(...(this.loaded.get(m.name)?.panels ?? []));
      } catch (e) {
        errors[m.name] = e instanceof Error ? e.message : String(e);
      }
    }
    this.active = panels;
    this.errors = errors;
    this.version++;
    for (const fn of [...this.listeners]) fn();
  }
}

export class ModulesError extends Error {
  constructor(message: string, readonly issues: ModuleProblem[]) {
    super(message);
    this.name = "ModulesError";
  }
}

async function json(res: Response, fallback: string): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* no body */
  }
  if (!res.ok) {
    throw new ModulesError(typeof body.error === "string" ? body.error : `${fallback}: HTTP ${res.status}`, Array.isArray(body.issues) ? (body.issues as ModuleProblem[]) : []);
  }
  return body;
}

export async function fetchModules(base = ""): Promise<ModulesState> {
  return (await json(await fetch(`${base}/api/editor/modules`), "module list failed")) as unknown as ModulesState;
}

/** Validate on the host and write only when valid; throws ModulesError with every problem otherwise. */
export async function saveEnabled(enabled: string[], base = ""): Promise<void> {
  await json(
    await fetch(`${base}/api/editor/modules`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) }),
    "module save failed",
  );
}

/** Restart the owned play server with the saved set (no-op when none is running). */
export async function applyModules(base = ""): Promise<{ restarted: boolean }> {
  return (await json(await fetch(`${base}/api/editor/modules/apply`, { method: "POST" }), "apply failed")) as unknown as { restarted: boolean };
}
