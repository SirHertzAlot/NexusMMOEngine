/// <reference types="vite/client" />
/**
 * Modules window (roadmap EA3 / EA9): every module under modules/, with a
 * switch to enable or disable it. A change is saved to content/modules.json
 * (validated by the host; a refused save shows every problem and writes
 * nothing). Editor contributions follow at once; server contributions take
 * effect when "Apply modules" restarts the play server.
 */

import * as React from "react";
import {
  ModuleRegistry,
  ModulesError,
  applyModules,
  buildNative,
  checkNative,
  fetchModules,
  fetchSidecarDump,
  fetchSidecars,
  parkSidecar,
  replaceSidecar,
  type SidecarState,
  loadersFromGlob,
  saveEnabled,
  type ModuleInfo,
  type ModuleProblem,
} from "../modules-client.js";
import { Button, MIcon, SectionTitle, Switch, notify } from "./components.js";

/** Editor entries are imported on demand, one per enabled module (Vite resolves the glob). */
export const moduleRegistry = new ModuleRegistry(
  loadersFromGlob(import.meta.glob("../../../../modules/*/editor/index.{ts,tsx}")),
  () => fetchModules(),
);
void moduleRegistry.refresh();

/** Re-render when the module set or the loaded contributions change. */
export function useModuleRegistry(): ModuleRegistry {
  React.useSyncExternalStore(
    (fn) => moduleRegistry.subscribe(fn),
    () => moduleRegistry.version,
  );
  return moduleRegistry;
}

const sameOrder = (a: string[] | null, b: string[] | null): boolean => a !== null && b !== null && a.join(" ") === b.join(" ");

/**
 * EA10: Build/Check buttons for a module's native addon.
 * Check reports whether the .node file exists; Build runs node-gyp.
 */
function NativeButtons({ module }: { module: ModuleInfo }): React.JSX.Element {
  const [built, setBuilt] = React.useState<boolean | null>(null);
  const [building, setBuilding] = React.useState(false);
  const [log, setLog] = React.useState<string | null>(null);

  async function check(): Promise<void> {
    try {
      const r = await checkNative(module.name);
      setBuilt(r.built);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  }

  async function build(): Promise<void> {
    setBuilding(true);
    setLog(null);
    try {
      const r = await buildNative(module.name);
      setBuilt(r.built);
      if (!r.built) setLog(`Build finished but ${module.native?.entry} not found.\n${r.stderr}`);
      else setLog(null);
    } catch (e) {
      setLog(e instanceof Error ? e.message : String(e));
      setBuilt(false);
    } finally {
      setBuilding(false);
    }
  }

  // Check on mount.
  React.useEffect(() => {
    void check();
  }, [module.name]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs">
        <Tag>{`native · ${module.native?.systems.length ?? 0} system${(module.native?.systems.length ?? 0) === 1 ? "" : "s"}`}</Tag>
        {built === null ? (
          <span style={{ color: "var(--m3-on-surface-variant)" }}>checking…</span>
        ) : built ? (
          <span style={{ color: "var(--m3-primary)" }}>built ✓</span>
        ) : (
          <span style={{ color: "var(--m3-error)" }}>not built</span>
        )}
        <span className="ml-auto flex gap-1">
          <Button size="sm" onClick={() => void check()} disabled={building}>
            Check
          </Button>
          <Button size="sm" onClick={() => void build()} disabled={building}>
            {building ? "Building…" : "Build"}
          </Button>
        </span>
      </div>
      {log && (
        <pre className="max-h-32 overflow-auto rounded p-2 text-[11px]" style={{ background: "var(--m3-surface-2)" }}>
          {log}
        </pre>
      )}
    </div>
  );
}

/**
 * EA11: a module's sidecar. Shows its state while the play server runs, parks it (stop for
 * good, leaving a debugging dump), replaces it with a fresh instance and shows the dump.
 */
function SidecarControls({ module }: { module: ModuleInfo }): React.JSX.Element {
  const [status, setStatus] = React.useState<SidecarState | "not running">("not running");
  const [hasDump, setHasDump] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [dump, setDump] = React.useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const r = await fetchSidecars();
      const mine = r.sidecars.find((s) => s.name === module.name);
      setStatus(mine ? mine.status : "not running");
      setHasDump(mine?.dump ?? false);
    } catch {
      setStatus("not running");
    }
  }
  React.useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [module.name]);

  async function act(run: () => Promise<unknown>, done: string): Promise<void> {
    setBusy(true);
    try {
      await run();
      notify(done);
      setDump(null);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  async function showDump(): Promise<void> {
    try {
      setDump(JSON.stringify((await fetchSidecarDump(module.name)).dump, null, 2));
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  }

  const running = status === "healthy" || status === "starting";
  const colour = status === "healthy" ? "var(--m3-primary)" : status === "unhealthy" ? "var(--m3-error)" : "var(--m3-on-surface-variant)";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs">
        <Tag>sidecar</Tag>
        <span style={{ color: colour }}>{status}</span>
        <span className="ml-auto flex gap-1">
          <Button size="sm" disabled={busy || !running} onClick={() => void act(() => parkSidecar(module.name, "parked from the editor"), `Parked ${module.name}. Its dump is ready.`)}>
            Park
          </Button>
          <Button size="sm" disabled={busy || status === "not running"} onClick={() => void act(() => replaceSidecar(module.name), `Started a fresh ${module.name}.`)}>
            Replace
          </Button>
          <Button size="sm" disabled={!hasDump} onClick={() => void showDump()}>
            Dump
          </Button>
        </span>
      </div>
      {dump && (
        <pre className="max-h-64 overflow-auto rounded p-2 text-[11px]" style={{ background: "var(--m3-surface-2)" }} aria-label={`${module.name} sidecar dump`}>
          {dump}
        </pre>
      )}
    </div>
  );
}

export function ModulesPanel(): React.JSX.Element {
  const reg = useModuleRegistry();
  const [busy, setBusy] = React.useState(false);
  const [issues, setIssues] = React.useState<ModuleProblem[]>([]);
  const state = reg.state;

  async function toggle(name: string, on: boolean): Promise<void> {
    if (!state) return;
    const next = on ? [...state.enabled, name] : state.enabled.filter((n) => n !== name);
    // Turning a module off also turns off what depends on it.
    const closed = on ? next : next.filter((n) => !state.modules.find((m) => m.name === n)?.dependsOn.some((d) => !next.includes(d)));
    setBusy(true);
    try {
      await saveEnabled(closed);
      setIssues([]);
    } catch (e) {
      setIssues(e instanceof ModulesError ? e.issues : [{ module: name, path: "", message: String(e) }]);
      if (!(e instanceof ModulesError) || e.issues.length === 0) notify(e instanceof Error ? e.message : String(e));
    } finally {
      await reg.refresh();
      setBusy(false);
    }
  }

  async function apply(): Promise<void> {
    setBusy(true);
    try {
      const r = await applyModules();
      notify(r.restarted ? "Play server restarted with the new module set. Press Play to reconnect." : "Saved. The set applies the next time the play server starts.");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      await reg.refresh();
      setBusy(false);
    }
  }

  if (!state) {
    return (
      <div className="p-4 text-sm" style={{ color: "var(--m3-on-surface-variant)" }}>
        {reg.errors["(host)"] ? `The editor host could not list modules: ${reg.errors["(host)"]}` : "Loading modules..."}
      </div>
    );
  }
  const stale = state.running !== null && !sameOrder(state.running.systems, state.tickOrder);
  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle>Modules</SectionTitle>
        <span className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
          {state.enabled.length} enabled of {state.modules.length}. Saved to content/modules.json.
        </span>
        <div className="ml-auto flex items-center gap-2">
          {stale && <Tag>Play server needs a restart</Tag>}
          <Button disabled={busy} onClick={() => void apply()}>
            <MIcon name="restart_alt" size={16} /> Apply modules
          </Button>
        </div>
      </div>

      {[...issues, ...state.problems].length > 0 && (
        <ul className="rounded-md p-3 text-xs" style={{ background: "var(--m3-error-container)", color: "var(--m3-on-error-container)" }} aria-label="Problems">
          {[...issues, ...state.problems].map((p, i) => (
            <li key={i}>
              {p.module}
              {p.path ? ` ${p.path}` : ""}: {p.message}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
        {state.modules.map((m) => (
          <div key={m.name} className="flex flex-col gap-2 rounded-lg p-3" style={{ background: "var(--m3-surface-1)" }}>
            <div className="flex items-center gap-2">
              <MIcon name="extension" size={18} />
              <span className="font-medium">{m.name}</span>
              <span className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
                v{m.version}
              </span>
              <span className="ml-auto">
                {m.locked ? <Tag>always on</Tag> : <Switch checked={m.enabled} label={`${m.enabled ? "Disable" : "Enable"} ${m.name}`} onChange={(on) => void toggle(m.name, on)} />}
              </span>
            </div>
            {m.description && (
              <p className="text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
                {m.description}
              </p>
            )}
            <div className="flex flex-wrap gap-1 text-xs">
              {m.editor && <Tag>editor</Tag>}
              {m.systems.length > 0 && <Tag>{`server · ${m.systems.length} system${m.systems.length === 1 ? "" : "s"}`}</Tag>}
              {m.dependsOn.map((d) => (
                <Tag key={d}>{`needs ${d}`}</Tag>
              ))}
              {m.editor && reg.errors[m.name] && <Tag>{`editor entry failed: ${reg.errors[m.name]}`}</Tag>}
            </div>
            {m.native && <NativeButtons module={m} />}
            {m.sidecar && m.enabled && <SidecarControls module={m} />}
          </div>
        ))}
        {state.invalid.map((m) => (
          <div key={m.name} className="rounded-lg p-3 text-xs" style={{ background: "var(--m3-error-container)", color: "var(--m3-on-error-container)" }}>
            <div className="font-medium">{m.name} (invalid manifest)</div>
            <ul>
              {m.problems.map((p, i) => (
                <li key={i}>
                  {p.path ? `${p.path}: ` : ""}
                  {p.message}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div>
        <SectionTitle>Tick order</SectionTitle>
        <p className="mb-1 text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
          {state.running ? "The running play server is using the order below the saved one." : "No play server is running; this is the order the saved set resolves to."}
        </p>
        <TickOrder label="Saved set" order={state.tickOrder} />
        {state.running && <TickOrder label="Running server" order={state.running.systems} />}
      </div>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="inline-flex h-6 items-center whitespace-nowrap rounded-md border px-2 text-xs" style={{ borderColor: "var(--m3-outline-variant)", color: "var(--m3-on-surface-variant)" }}>
      {children}
    </span>
  );
}

function TickOrder({ label, order }: { label: string; order: string[] | null }): React.JSX.Element {
  return (
    <div className="mb-2">
      <div className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
        {label}
      </div>
      <div className="flex flex-wrap gap-1">
        {order ? order.map((s, i) => <Tag key={`${s}${i}`}>{s}</Tag>) : <span className="text-xs">does not resolve: see the problems above</span>}
      </div>
    </div>
  );
}
