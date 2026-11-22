/**
 * Forge entity inspector — the 2026 design language on a real screen
 * (docs/EDITOR-UI-2026.md §3 item 3, slice EU3).
 *
 * This is presentation only. Every number, name and field on it comes
 * from code that already existed:
 *
 *   - the mirror session, filters and selection come from
 *     `useEcsInspectorSession()` in ecs-inspector.tsx — the SAME hook the
 *     Material 3 panel mounts, so the two cannot drift apart;
 *   - field types, the systems that read and write each component, and
 *     the archetype come from the committed ECS graph through
 *     `fetchEcsGraph` / `indexEcsGraph` in ecs-graph-model.ts.
 *
 * Two honest departures from the mockup:
 *
 *   - The mockup's ACTIVE / SLEEPING / DISABLED is a control. Our
 *     view-model is deliberately read-only (inspectors/ecs.ts exposes no
 *     mutation API), so the segment here is a read-out of liveness
 *     derived from the entity's own velocity and health, and it does not
 *     claim to set anything.
 *   - The mockup prints a byte size per component. We do not measure one
 *     yet; the field count and types we do have are shown instead. The
 *     profiler slice (EU7) is where real sizes come from.
 */

import * as React from "react";
import { useEcsInspectorSession } from "./ecs-inspector.js";
import type { EntitySnapshot } from "../inspectors/ecs.js";
import { KvTable } from "./data-table.js";
import {
  fetchEcsGraph,
  indexEcsGraph,
  normalizeComponentName,
  type EcsGraphIndex,
} from "../ecs-graph-model.js";

export type TabId = "details" | "components" | "systems";

/** Hue per component family — the mockup's letter badge, one colour each. */
const HUE: Readonly<Record<string, string>> = {
  transform: "var(--fg-accent)",
  velocity: "var(--fg-axis-z)",
  intent: "var(--fg-note)",
  chunk: "var(--fg-text-dim)",
  health: "var(--fg-bad)",
  body: "var(--fg-ok)",
};

function hueOf(kind: string): string {
  return HUE[kind] ?? "var(--fg-text-dim)";
}

/** The committed ECS graph, fetched once per mount. */
function useGraphIndex(): EcsGraphIndex | null {
  const [index, setIndex] = React.useState<EcsGraphIndex | null>(null);
  React.useEffect(() => {
    let live = true;
    fetchEcsGraph()
      .then((payload) => {
        if (live) setIndex(indexEcsGraph(payload));
      })
      .catch(() => undefined); // the graph is optional context, never a blocker
    return () => {
      live = false;
    };
  }, []);
  return index;
}

/** `transform` -> `Transform`, matched against the graph's own names. */
function graphName(kind: string, index: EcsGraphIndex | null): string {
  const titled = kind.charAt(0).toUpperCase() + kind.slice(1);
  return index ? normalizeComponentName(titled, index.components) : titled;
}

function Label({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="fg-label">{children}</span>;
}

function Dot({ tone }: { tone: string }): React.JSX.Element {
  return <i className="fg-dot" style={{ color: tone }} aria-hidden />;
}

/**
 * Liveness read-out. Derived from the live component values, not stored:
 * down if health is at zero, moving if velocity is non-zero, idle else.
 */
export function liveness(
  fields: ReadonlyMap<string, ReadonlyMap<string, string>>,
): "moving" | "idle" | "down" {
  const current = fields.get("health")?.get("current");
  if (current !== undefined && Number.parseFloat(current) <= 0) return "down";
  const vel = fields.get("velocity");
  if (vel) {
    for (const axis of ["lx", "ly", "lz"]) {
      const v = vel.get(axis);
      if (v !== undefined && Math.abs(Number.parseFloat(v)) > 1e-4) return "moving";
    }
  }
  return "idle";
}

/**
 * What the view needs from a session. The live hook satisfies it; so
 * does a fixture built over the same `EcsInspector` view-model, which is
 * how the tests and the capture harness mount this panel without a
 * running server.
 */
export interface ForgeInspectorSession {
  selected: string | null;
  detail: ReadonlyArray<{ component: string; fields: Array<{ key: string; value: string }> }> | undefined;
  inspector: { getTick(): number; readonlyNotice: string };
}

/** Live panel: the shared session hook, rendered by the view below. */
export function ForgeEntityInspector({
  fixture,
  initialSelected,
}: { fixture?: () => EntitySnapshot; initialSelected?: string } = {}): React.JSX.Element {
  const session = useEcsInspectorSession(fixture, initialSelected);
  return <ForgeInspectorView session={session} />;
}

export function ForgeInspectorView({
  session,
  initialTab = "components",
}: {
  session: ForgeInspectorSession;
  /** Which tab opens first. A deep link and the tests both need to say. */
  initialTab?: TabId;
}): React.JSX.Element {
  const index = useGraphIndex();
  const [tab, setTab] = React.useState<TabId>(initialTab);
  const [open, setOpen] = React.useState<string | null>(null);

  const detail = session.detail ?? [];
  const byKind = new Map<string, Map<string, string>>(
    detail.map((c) => [c.component, new Map(c.fields.map((f) => [f.key, f.value]))]),
  );
  const state = liveness(byKind);
  const archetype = detail.map((c) => graphName(c.component, index)).join(" · ");

  if (!session.selected) {
    return (
      <aside className="fg-panel flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Label>Inspector</Label>
        <p className="fg-data">Select an entity to inspect it.</p>
      </aside>
    );
  }

  return (
    <aside className="fg-panel flex h-full min-h-0 flex-col">
      {/* ---------------------------------------------------- identity */}
      <header className="flex items-center gap-3 p-3">
        <span className="fg-badge" style={{ color: "var(--fg-accent)" }}>
          E
        </span>
        <span className="min-w-0">
          <span className="block truncate" style={{ color: "var(--fg-text)", fontSize: 13 }}>
            Entity {session.selected}
          </span>
          <span className="fg-data block truncate">
            {detail.length} components · tick {session.inspector.getTick()}
          </span>
        </span>
      </header>

      {/* ------------------------------------------------- liveness */}
      <div className="px-3 pb-3">
        <div className="fg-seg w-full" role="group" aria-label="Liveness (read-only)">
          {(
            [
              ["moving", "var(--fg-ok)"],
              ["idle", "var(--fg-warn)"],
              ["down", "var(--fg-bad)"],
            ] as const
          ).map(([id, tone]) => (
            <button
              key={id}
              type="button"
              disabled
              aria-pressed={state === id}
              className="fg-label flex flex-1 items-center justify-center gap-1.5"
              title="Read-out, not a control: the ECS inspector has no edit path."
            >
              <Dot tone={state === id ? tone : "var(--fg-text-faint)"} />
              {id}
            </button>
          ))}
        </div>
      </div>

      {/* ----------------------------------------------------- tabs */}
      <div
        className="flex px-3"
        role="tablist"
        style={{ borderBottom: "1px solid var(--fg-line-soft)" }}
      >
        {(
          [
            ["details", "Details"],
            ["components", `Components (${detail.length})`],
            ["systems", "Systems"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className="fg-tab fg-label"
          >
            {label}
          </button>
        ))}
      </div>

      <div className="m3-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "details" && (
          <div className="flex flex-col gap-3">
            {detail.map((c) => (
              <section key={c.component} className="flex flex-col gap-1">
                <Label>{graphName(c.component, index)}</Label>
                <KvTable rows={c.fields} />
              </section>
            ))}
          </div>
        )}

        {tab === "components" && (
          <div className="flex flex-col gap-1.5">
            {detail.map((c) => {
              const name = graphName(c.component, index);
              const types = index?.fieldsByComponent.get(name) ?? [];
              const summary =
                types.length > 0
                  ? types.slice(0, 3).map((f) => f.name).join(" · ")
                  : c.fields.slice(0, 3).map((f) => f.key).join(" · ");
              const expanded = open === c.component;
              return (
                <div key={c.component} className="fg-row" aria-selected={expanded}>
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : c.component)}
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-3 px-2.5 py-2 text-left"
                  >
                    <span className="fg-badge" style={{ color: hueOf(c.component) }}>
                      {name.charAt(0)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate"
                        style={{ color: "var(--fg-text)", fontSize: 12 }}
                      >
                        {name}
                      </span>
                      <span className="fg-data block truncate">{summary}</span>
                    </span>
                    <span className="fg-data fg-dim">{c.fields.length}f</span>
                    <span className="fg-data fg-dim">{expanded ? "−" : "›"}</span>
                  </button>
                  {expanded && (
                    <div className="px-2.5 pb-2.5">
                      <KvTable rows={c.fields} />
                      {types.length > 0 && (
                        <p className="fg-data mt-1.5">
                          {types.map((f) => `${f.name}: ${f.type}`).join("  ·  ")}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <p className="fg-data fg-dim mt-1">
              Read-only: {session.inspector.readonlyNotice}
            </p>
          </div>
        )}

        {tab === "systems" && (
          <div className="flex flex-col gap-2.5">
            {!index && <p className="fg-data">No ECS graph available.</p>}
            {index &&
              detail.map((c) => {
                const name = graphName(c.component, index);
                const access = index.accessByComponent.get(name);
                const rows = [
                  ...(access?.writes ?? []).map((s) => ({ ...s, role: "writes" })),
                  ...(access?.reads ?? []).map((s) => ({ ...s, role: "reads" })),
                ];
                return (
                  <section key={c.component} className="flex flex-col gap-1">
                    <Label>{name}</Label>
                    {rows.length === 0 && <p className="fg-data fg-dim">no system declares it</p>}
                    {rows.map((s) => (
                      <div
                        key={`${s.role}:${s.system}`}
                        className="fg-row flex items-center gap-2 px-2 py-1"
                      >
                        <Dot
                          tone={s.role === "writes" ? "var(--fg-warn)" : "var(--fg-text-faint)"}
                        />
                        <span className="fg-data flex-1" style={{ color: "var(--fg-text)" }}>
                          {s.system}
                        </span>
                        <span className="fg-label">{s.role}</span>
                        <span className="fg-label" style={{ opacity: s.declared ? 1 : 0.5 }}>
                          {s.confidence}
                        </span>
                      </div>
                    ))}
                  </section>
                );
              })}
          </div>
        )}
      </div>

      {/* ------------------------------------------------- archetype */}
      <footer
        className="p-3"
        style={{ borderTop: "1px solid var(--fg-line-soft)", background: "var(--fg-sunken)" }}
      >
        <Label>Archetype</Label>
        <p className="fg-data mt-1 break-words" style={{ color: "var(--fg-text)" }}>
          {archetype || "—"}
        </p>
      </footer>
    </aside>
  );
}
