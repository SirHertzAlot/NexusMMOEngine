/**
 * Forge systems list — every system, its component signature, and what
 * it costs (docs/EDITOR-UI-2026.md §2.3, slice EU4).
 *
 * The functionality mockup lists every system with a component
 * signature and a tick cost beside it. Both already exist here, in two
 * places that had never met:
 *
 *   - the signature comes from the committed ECS graph
 *     (`/api/editor/graph`), which indexes reads, writes and excludes
 *     per component along with how each edge was established — declared
 *     in the system's own access list, or only inferred from its body;
 *   - the cost comes from the running server's tick timings, through
 *     the same `useTickTimings()` poll the profiler mounts.
 *
 * The join is this panel's only contribution. It measures nothing, it
 * reads no new endpoint, and it never pretends a system is free: with
 * no server running there is no cost column at all, rather than zeros.
 *
 * Confidence is shown because it changes what the row means. A system
 * whose access is `declared` has told the engine what it touches and
 * the scheduler can trust it; one that is only `inferred` was read out
 * of its source, and the signature may be incomplete.
 */

import * as React from "react";
import {
  fetchEcsGraph,
  indexEcsGraph,
  type EcsGraphIndex,
  type EdgeConfidence,
} from "../ecs-graph-model.js";
import { TICK_BUDGET_MS, budgetTone, useTickTimings } from "./forge-profiler.js";

export type AccessKind = "writes" | "reads" | "excludes";

export interface SystemSignature {
  system: string;
  writes: string[];
  reads: string[];
  excludes: string[];
  /** The weakest confidence among this system's edges: what the row can be trusted to. */
  confidence: EdgeConfidence;
}

const CONFIDENCE_RANK: Readonly<Record<EdgeConfidence, number>> = {
  declared: 4,
  introspected: 3,
  extracted: 2,
  inferred: 1,
};

/**
 * Invert the graph's component-keyed access index into one row per
 * system. A component appears under the strongest access it has: a
 * system that both reads and writes `Transform` writes it, because that
 * is what decides ordering and conflicts.
 */
export function systemSignatures(index: EcsGraphIndex): SystemSignature[] {
  const rows = new Map<string, { writes: Set<string>; reads: Set<string>; excludes: Set<string>; confidence: EdgeConfidence }>();
  const row = (system: string) => {
    let r = rows.get(system);
    if (!r) {
      r = { writes: new Set(), reads: new Set(), excludes: new Set(), confidence: "declared" };
      rows.set(system, r);
    }
    return r;
  };

  for (const [component, access] of index.accessByComponent) {
    for (const kind of ["writes", "reads", "excludes"] as const) {
      for (const badge of access[kind]) {
        const r = row(badge.system);
        r[kind].add(component);
        if (CONFIDENCE_RANK[badge.confidence] < CONFIDENCE_RANK[r.confidence]) {
          r.confidence = badge.confidence;
        }
      }
    }
  }

  return [...rows.entries()]
    .map(([system, r]) => ({
      system,
      // A written component is not also listed as read: the strongest wins.
      writes: [...r.writes].sort(),
      reads: [...r.reads].filter((c) => !r.writes.has(c)).sort(),
      excludes: [...r.excludes].sort(),
      confidence: r.confidence,
    }))
    .sort((a, b) => a.system.localeCompare(b.system));
}

export interface SystemRow extends SystemSignature {
  /** Mean ms per tick, when a server is running and has reported one. */
  costMs: number | null;
}

/**
 * Join signatures to costs. Rows keep the graph's spelling of a system
 * name; a cost with no matching system, or a system the server never
 * reported, simply has no number — neither side invents the other.
 */
export function joinCosts(
  signatures: readonly SystemSignature[],
  costs: ReadonlyMap<string, number> | null,
): SystemRow[] {
  return signatures.map((s) => ({ ...s, costMs: costs?.get(s.system) ?? null }));
}

/** Sort dearest first when costs are known, else by name. */
export function orderRows(rows: readonly SystemRow[]): SystemRow[] {
  const anyCost = rows.some((r) => r.costMs !== null);
  if (!anyCost) return [...rows];
  return [...rows].sort((a, b) => (b.costMs ?? -1) - (a.costMs ?? -1) || a.system.localeCompare(b.system));
}

const CHIP_TONE: Readonly<Record<AccessKind, string>> = {
  writes: "var(--fg-warn)",
  reads: "var(--fg-text-dim)",
  excludes: "var(--fg-bad)",
};

const CHIP_MARK: Readonly<Record<AccessKind, string>> = {
  writes: "W",
  reads: "R",
  excludes: "✗",
};

function Chips({ kind, items }: { kind: AccessKind; items: readonly string[] }): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <>
      {items.map((c) => (
        <span
          key={`${kind}:${c}`}
          className="fg-sig"
          style={{ color: CHIP_TONE[kind] }}
          title={`${kind}: ${c}`}
        >
          <b>{CHIP_MARK[kind]}</b>
          {c}
        </span>
      ))}
    </>
  );
}

/** The committed graph, fetched once per mount; absence is not an error. */
function useGraphIndex(
  read: () => Promise<EcsGraphIndex | null> = async () => indexEcsGraph(await fetchEcsGraph()),
): EcsGraphIndex | null {
  const [index, setIndex] = React.useState<EcsGraphIndex | null>(null);
  React.useEffect(() => {
    let live = true;
    read()
      .then((i) => {
        if (live) setIndex(i);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [read]);
  return index;
}

export function ForgeSystemsView({
  signatures,
  costs,
  budgetMs = TICK_BUDGET_MS,
}: {
  signatures: readonly SystemSignature[] | null;
  /** System name -> mean ms per tick, or null when no server is running. */
  costs: ReadonlyMap<string, number> | null;
  budgetMs?: number;
}): React.JSX.Element {
  if (signatures === null) {
    return (
      <section className="fg-panel p-3">
        <span className="fg-label">Systems</span>
        <p className="fg-data mt-1">No ECS graph available.</p>
      </section>
    );
  }

  const rows = orderRows(joinCosts(signatures, costs));
  const declared = rows.filter((r) => r.confidence === "declared").length;

  return (
    <section className="fg-panel flex min-h-0 flex-col">
      <header className="flex items-baseline gap-3 p-3">
        <span className="fg-label">Systems ({rows.length})</span>
        <span className="fg-data fg-dim">
          {declared}/{rows.length} declare their access
          {costs === null ? " · no server running, so no cost" : ""}
        </span>
      </header>

      <div className="m3-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {rows.length === 0 && <p className="fg-data fg-dim">The graph names no system.</p>}
        {rows.map((r) => (
          <div key={r.system} className="fg-row flex flex-col gap-1 px-2.5 py-2">
            <div className="flex items-baseline gap-2">
              <span
                className="fg-data min-w-0 flex-1 truncate"
                style={{ color: "var(--fg-text)" }}
                title={r.system}
              >
                {r.system}
              </span>
              {r.confidence !== "declared" && (
                <span
                  className="fg-label"
                  title="The graph inferred this system's access from its source rather than reading a declared list; the signature may be incomplete."
                >
                  {r.confidence}
                </span>
              )}
              {r.costMs !== null && (
                <span
                  className="fg-data"
                  style={{ color: CHIP_TONE_FOR_COST(r.costMs, budgetMs) }}
                  title={`${((r.costMs / budgetMs) * 100).toFixed(1)}% of the ${budgetMs.toFixed(1)} ms tick`}
                >
                  {r.costMs.toFixed(3)} ms
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              <Chips kind="writes" items={r.writes} />
              <Chips kind="reads" items={r.reads} />
              <Chips kind="excludes" items={r.excludes} />
              {r.writes.length + r.reads.length + r.excludes.length === 0 && (
                <span className="fg-data fg-dim">no component access in the graph</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CHIP_TONE_FOR_COST(ms: number, budgetMs: number): string {
  const tone = budgetTone(ms / budgetMs);
  return tone === "ok" ? "var(--fg-text)" : tone === "warn" ? "var(--fg-warn)" : "var(--fg-bad)";
}

/** Live panel: the committed graph joined to the running server's timings. */
export function ForgeSystemsPanel(): React.JSX.Element {
  const index = useGraphIndex();
  const timings = useTickTimings();
  const signatures = React.useMemo(() => (index ? systemSignatures(index) : null), [index]);
  const costs = React.useMemo(
    () =>
      timings.kind === "timings"
        ? new Map(timings.timings.systems.map((s) => [s.name, s.avg]))
        : null,
    [timings],
  );
  return <ForgeSystemsView signatures={signatures} costs={costs} />;
}
