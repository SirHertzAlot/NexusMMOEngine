/**
 * Graphify H4 ECS Footprint panel (`GRAPHIFY-HARVESTER-SPEC.md §8 & §9 H4`):
 * displays per-component static system access (`Reads` / `Writes` / `Excludes` +
 * `declared` vs `inferred` confidence), UI widgets, live values + bounded per-field
 * `lastWriter` (`<system> @ t<tick>`), and an explicit graph staleness badge.
 */

import * as React from "react";
import { Badge } from "./components.js";
import {
  buildEntityFootprint,
  checkGraphStaleness,
  fetchEcsGraph,
  indexEcsGraph,
  parseLiveEntityOverlay,
  type EcsGraphIndex,
  type EntityFootprint,
  type GraphStaleness,
  type LiveEntityOverlay,
  type SystemAccessBadge,
} from "../ecs-graph-model.js";

/** Structural admin channel compatible with both `selection-card.tsx` and `serverLink.admin`. */
export interface FootprintAdminSender {
  admin(command: string, args?: unknown): Promise<{ ok: boolean; message: string }>;
}

/** Fetch & index `/api/editor/graph` for the current selection. */
export function useEcsGraph(objectId?: string): {
  index: EcsGraphIndex | null;
  loading: boolean;
  error: string | null;
} {
  const [state, setState] = React.useState<{
    index: EcsGraphIndex | null;
    loading: boolean;
    error: string | null;
  }>({ index: null, loading: true, error: null });

  React.useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    fetchEcsGraph(objectId)
      .then((payload) => {
        if (!alive) return;
        setState({ index: indexEcsGraph(payload), loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setState({
          index: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      alive = false;
    };
  }, [objectId]);

  return state;
}

/**
 * Poll selection-scoped `inspect { entity, format: "json" }` ONLY while an
 * entity (`wireId`) is actively inspected and `admin` is connected.
 */
export function useLiveOverlay(
  wireId: string | undefined,
  admin: FootprintAdminSender | undefined,
  pollMs = 1500,
): { overlay: LiveEntityOverlay | null; error: string | null } {
  const [state, setState] = React.useState<{ overlay: LiveEntityOverlay | null; error: string | null }>({
    overlay: null,
    error: null,
  });

  React.useEffect(() => {
    if (!wireId || !admin) {
      setState({ overlay: null, error: null });
      return;
    }
    let alive = true;
    let inFlight = false;
    const sample = async (): Promise<void> => {
      if (inFlight || !alive) return;
      inFlight = true;
      try {
        const res = await admin.admin("inspect", { entity: wireId, format: "json" });
        if (!alive) return;
        if (!res.ok) {
          setState((prev) => ({ ...prev, error: res.message }));
        } else {
          setState({ overlay: parseLiveEntityOverlay(res.message), error: null });
        }
      } catch (err: unknown) {
        if (!alive) return;
        setState((prev) => ({ ...prev, error: err instanceof Error ? err.message : String(err) }));
      } finally {
        inFlight = false;
      }
    };

    void sample();
    const id = setInterval(() => void sample(), pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [wireId, admin, pollMs]);

  return state;
}

function stalenessTone(state: GraphStaleness["state"]): "ok" | "warn" | "default" {
  if (state === "synced") return "ok";
  if (state === "stale") return "warn";
  return "default";
}

function renderSystemBadge(kind: "W" | "R" | "X", badge: SystemAccessBadge): React.JSX.Element {
  const inferred = badge.confidence === "inferred";
  const prefix = kind === "W" ? "write" : kind === "R" ? "read" : "excl";
  return (
    <span
      key={`${kind}:${badge.system}`}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] border border-border/60"
      style={{
        background: inferred ? "rgba(217, 119, 6, 0.14)" : "var(--m3-surface-2, rgba(255,255,255,0.06))",
      }}
      title={`${badge.system} (${badge.role}, ${badge.confidence}${badge.fields.length ? `: ${badge.fields.join(", ")}` : ""})`}
    >
      <span className="text-muted-foreground">{prefix}</span>
      <span>{badge.system}</span>
      {badge.tickIndex !== undefined && <span className="text-muted-foreground">#{badge.tickIndex}</span>}
      {inferred && <span className="text-amber-300">inferred</span>}
    </span>
  );
}

/** Pure presentational view of joined static Graphify + live H4 overlay footprint. */
export function EcsFootprintContent({
  footprint,
  staleness,
  overlay,
  loading,
  error,
}: {
  footprint: EntityFootprint | null;
  staleness: GraphStaleness | null;
  overlay: LiveEntityOverlay | null;
  loading?: boolean;
  error?: string | null;
}): React.JSX.Element {
  return (
    <section
      className="mt-2 flex flex-col gap-2 rounded-md border border-border/70 p-2 text-[11px]"
      data-testid="ecs-footprint-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          ECS Footprint
        </span>
        {staleness && (
          <Badge
            tone={stalenessTone(staleness.state)}
            className="px-2 py-0 text-[10px] font-mono"
            data-testid="graph-staleness-badge"
            title={
              staleness.state === "stale"
                ? `Run npm run graphify:build to refresh content/graph/ecs-graph.json (${staleness.reason})`
                : staleness.reason
            }
          >
            {staleness.reason}
          </Badge>
        )}
      </div>

      {overlay && (
        <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground">
          <span>live entity #{overlay.wireId}</span>
          <span>tick {overlay.tick}</span>
        </div>
      )}

      {footprint?.archetypeId && (
        <div className="font-mono text-[10px] text-muted-foreground">
          archetype: {footprint.archetypeId.replace(/^archetype:/, "")}
        </div>
      )}

      {loading && !footprint && <p className="text-[10px] text-muted-foreground">Loading ECS graph…</p>}
      {error && <p className="text-[10px] text-amber-300">{error}</p>}

      {footprint && footprint.components.length === 0 && (
        <p className="text-[10px] text-muted-foreground">No mapped ECS components in Graphify for this selection.</p>
      )}

      {footprint &&
        footprint.components.map((comp) => {
          const hasLiveWriters = comp.fields.some((f) => Boolean(f.lastWriter));
          return (
            <details
              key={comp.component}
              open={hasLiveWriters || footprint.components.length <= 4}
              className="rounded border border-border/50 px-2 py-1"
            >
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-1 font-medium">
                <span className="flex items-center gap-1.5">
                  <span>{comp.component}</span>
                  {comp.tag && <span className="font-mono text-[10px] text-muted-foreground">(tag)</span>}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {comp.writers.length}W · {comp.readers.length}R
                  {comp.excludes.length > 0 ? ` · ${comp.excludes.length}X` : ""}
                </span>
              </summary>

              <div className="mt-1.5 flex flex-col gap-1.5">
                {comp.widgets.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 font-mono text-[10px]">
                    <span className="text-muted-foreground">widgets:</span>
                    {comp.widgets.map((w) => (
                      <span key={w} className="rounded bg-secondary/60 px-1.5 py-0.5 text-[10px]">
                        {w}
                      </span>
                    ))}
                  </div>
                )}

                {(comp.writers.length > 0 || comp.readers.length > 0 || comp.excludes.length > 0) && (
                  <div className="flex flex-wrap gap-1">
                    {comp.writers.map((b) => renderSystemBadge("W", b))}
                    {comp.readers.map((b) => renderSystemBadge("R", b))}
                    {comp.excludes.map((b) => renderSystemBadge("X", b))}
                  </div>
                )}

                {comp.fields.length > 0 && (
                  <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-0.5 border-t border-border/40 pt-1 font-mono text-[10px]">
                    {comp.fields.map((f) => (
                      <React.Fragment key={f.name}>
                        <dt className="flex items-center gap-1.5 text-muted-foreground">
                          <span>{f.name}</span>
                          {f.type && <span className="opacity-65">:{f.type}</span>}
                        </dt>
                        <dd className="flex items-center justify-end gap-1.5 text-right">
                          {f.liveValue !== undefined && <span>{f.liveValue}</span>}
                          {f.lastWriter && (
                            <span
                              className="rounded bg-emerald-900/60 px-1 text-emerald-200"
                              data-testid={`last-writer-${comp.component}-${f.name}`}
                            >
                              {f.lastWriter.system} @ t{f.lastWriter.tick}
                            </span>
                          )}
                        </dd>
                      </React.Fragment>
                    ))}
                  </dl>
                )}
              </div>
            </details>
          );
        })}
    </section>
  );
}

/** Connected Graphify H4 ECS Footprint panel mounted in selection panes. */
export function EcsFootprintSection({
  componentNames,
  wireId,
  objectId,
  admin,
}: {
  componentNames: readonly string[];
  wireId?: string;
  objectId?: string;
  admin?: FootprintAdminSender;
}): React.JSX.Element {
  const { index, loading, error: graphError } = useEcsGraph(objectId);
  const { overlay, error: overlayError } = useLiveOverlay(wireId, admin);

  const footprint = React.useMemo(
    () => (index ? buildEntityFootprint(index, { componentNames, objectId, live: overlay }) : null),
    [index, componentNames, objectId, overlay],
  );
  const staleness = React.useMemo(
    () =>
      index
        ? checkGraphStaleness(index.meta.builtFromCommit, overlay?.buildCommit ?? null, index.currentHead)
        : null,
    [index, overlay?.buildCommit],
  );

  return (
    <EcsFootprintContent
      footprint={footprint}
      staleness={staleness}
      overlay={overlay}
      loading={loading}
      error={graphError ?? overlayError}
    />
  );
}
