/**
 * EntityInspector component under apps/editor/src/ui/EntityInspector.tsx
 * Lists entities and shows selected entity details.
 */

import * as React from "react";
import { fetchEntities, fetchEntityDetail, type EntitySummary, type EntityDetail } from "../api/entity.js";

export function EntityInspector(): React.JSX.Element {
  const [entities, setEntities] = React.useState<EntitySummary[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<EntityDetail | null>(null);
  const [loading, setLoading] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState<string>("");

  const loadEntities = React.useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchEntities();
      setEntities(data);
      if (data.length > 0 && !selectedId) {
        setSelectedId(data[0].id);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  React.useEffect(() => {
    void loadEntities();
  }, [loadEntities]);

  React.useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let active = true;
    void fetchEntityDetail(selectedId).then((res) => {
      if (active) setDetail(res);
    });
    return () => {
      active = false;
    };
  }, [selectedId]);

  const filtered = entities.filter((e) =>
    e.name.toLowerCase().includes(search.toLowerCase()) ||
    e.type.toLowerCase().includes(search.toLowerCase()) ||
    e.id.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 text-[13px]" data-testid="entity-inspector">
      <div className="flex items-center justify-between border-b pb-2">
        <div className="flex items-center gap-2 font-medium">
          <span aria-hidden="true">🔎</span>
          <span>Entity Inspector</span>
        </div>
        <button
          onClick={() => void loadEntities()}
          className="rounded px-2 py-1 text-xs font-medium hover:bg-surface-variant transition-colors"
          style={{ background: "var(--m3-surface-2)", color: "var(--m3-on-surface)" }}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded p-2 text-xs" style={{ background: "var(--m3-error-container)", color: "var(--m3-on-error-container)" }}>
          Error: {error}
        </div>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Filter entities..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded border px-2.5 py-1.5 text-xs outline-none"
          style={{ background: "var(--m3-surface-2)", borderColor: "var(--m3-outline-variant)" }}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1 min-h-0">
        {/* Entity List */}
        <div className="flex flex-col border rounded-lg overflow-hidden" style={{ borderColor: "var(--m3-outline-variant)", background: "var(--m3-surface)" }}>
          <div className="bg-surface-variant px-3 py-2 text-xs font-semibold border-b" style={{ borderColor: "var(--m3-outline-variant)" }}>
            Entities ({filtered.length})
          </div>
          <div className="flex-1 overflow-y-auto divide-y" style={{ borderColor: "var(--m3-outline-variant)" }}>
            {loading && entities.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">Loading entities...</div>
            ) : filtered.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">No entities found</div>
            ) : (
              filtered.map((ent) => {
                const isSelected = ent.id === selectedId;
                return (
                  <button
                    key={ent.id}
                    onClick={() => setSelectedId(ent.id)}
                    className={`w-full text-left px-3 py-2.5 flex flex-col gap-1 transition-colors ${
                      isSelected ? "bg-primary/10 font-medium" : "hover:bg-surface-variant/50"
                    }`}
                    style={isSelected ? { background: "var(--m3-primary-container)", color: "var(--m3-on-primary-container)" } : {}}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{ent.name}</span>
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-surface-variant">
                        {ent.type}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground font-mono">
                      pos: ({ent.x.toFixed(1)}, {ent.y.toFixed(1)}, {ent.z.toFixed(1)})
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Entity Details */}
        <div className="flex flex-col border rounded-lg overflow-hidden" style={{ borderColor: "var(--m3-outline-variant)", background: "var(--m3-surface)" }}>
          <div className="bg-surface-variant px-3 py-2 text-xs font-semibold border-b" style={{ borderColor: "var(--m3-outline-variant)" }}>
            Entity Details
          </div>
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
            {detail ? (
              <>
                <div className="flex flex-col gap-1 pb-2 border-b" style={{ borderColor: "var(--m3-outline-variant)" }}>
                  <div className="text-base font-bold">{detail.name}</div>
                  <div className="text-xs text-muted-foreground font-mono">ID: {detail.id} | Type: {detail.type}</div>
                  {detail.health && (
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs font-medium">Health:</span>
                      <div className="flex-1 bg-surface-variant rounded-full h-2 overflow-hidden">
                        <div
                          className="bg-red-500 h-full transition-all"
                          style={{ width: `${Math.max(0, Math.min(100, (detail.health.current / detail.health.max) * 100))}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono">{detail.health.current} / {detail.health.max}</span>
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Components</span>
                  <pre
                    className="p-2.5 rounded text-xs font-mono overflow-x-auto"
                    style={{ background: "var(--m3-surface-2)", color: "var(--m3-on-surface)" }}
                  >
                    {JSON.stringify(detail.components, null, 2)}
                  </pre>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                Select an entity to view details
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
