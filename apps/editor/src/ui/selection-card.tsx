/**
 * Selection card panel (ROADMAP E6): renders inspectors/selection.ts's
 * card for the entity picked in the game view. Presentation only; the
 * view-model does the work.
 */

import * as React from "react";
import { DataTable } from "./data-table.js";
import { Button } from "./components.js";
import type { SelectedEntity, SelectionCard } from "../inspectors/selection.js";
import {
  despawnCommand,
  editableField,
  healCommand,
  inspectCommand,
  sendAdmin,
  setCommand,
  teleportHereCommand,
  type AdminCall,
  type AdminOutcome,
} from "../inspectors/entity-actions.js";
import type { PcgAssetView } from "../pcg-host.js";

/** The PICG library from the dev host, fetched once per mount (empty until it answers). */
export function usePcgLibrary(): { assets: PcgAssetView[]; error: string | null } {
  const [state, setState] = React.useState<{ assets: PcgAssetView[]; error: string | null }>({ assets: [], error: null });
  React.useEffect(() => {
    let live = true;
    fetch("/api/editor/pcg/library")
      .then(async (res) => {
        const body = (await res.json()) as { ok: boolean; assets?: PcgAssetView[]; error?: string };
        if (!live) return;
        setState(body.ok ? { assets: body.assets ?? [], error: null } : { assets: [], error: body.error ?? `HTTP ${res.status}` });
      })
      .catch((e: unknown) => live && setState({ assets: [], error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** Sends admin commands (MirrorClient). */
export interface AdminSender {
  admin(command: string, args?: unknown): Promise<AdminOutcome>;
}

/**
 * One whitelisted field: shows the live value until focused, then the
 * draft; Enter or blur sends `set`, Escape drops the draft.
 */
function EditableValue({ value, label, onCommit }: { value: string; label: string; onCommit: (text: string) => void }): React.JSX.Element {
  const [draft, setDraft] = React.useState<string | null>(null);
  const cancelled = React.useRef(false);
  return (
    <input
      className="h-5 w-full rounded-sm border border-transparent bg-transparent px-1 font-mono text-foreground hover:border-input focus:border-ring focus:outline-none"
      aria-label={label}
      value={draft ?? value}
      onFocus={() => {
        cancelled.current = false;
        setDraft(value);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation(); // keep game keys out of the box
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        if (!cancelled.current && draft !== null && draft !== value) onCommit(draft);
        setDraft(null);
      }}
    />
  );
}

/** Server actions on the picked entity, and the last answer. */
function EntityActions({ entity, admin, onResult }: { entity: SelectedEntity; admin: AdminSender; onResult: (label: string, out: AdminOutcome) => void }): React.JSX.Element {
  const wireId = entity.wireId.toString();
  const run = (label: string, call: AdminCall | { error: string }): void => {
    void sendAdmin(admin, call).then((out) => onResult(label, out));
  };
  const btn = "h-7 px-2 text-xs";
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="selection-actions">
      <Button size="sm" className={btn} variant="secondary" onClick={() => run("inspect", inspectCommand(wireId))}>
        server inspect
      </Button>
      <Button size="sm" className={btn} variant="secondary" disabled={entity.health === undefined} onClick={() => run("heal", healCommand(entity))}>
        heal
      </Button>
      <Button size="sm" className={btn} variant="secondary" disabled={entity.transform === undefined} onClick={() => run("teleport", teleportHereCommand(entity))}>
        teleport me here
      </Button>
      <Button size="sm" className={btn} variant="danger" onClick={() => run("despawn", despawnCommand(wireId))}>
        despawn
      </Button>
    </div>
  );
}

export function SelectionCardView({
  card,
  libraryError,
  entity,
  admin,
}: {
  card: SelectionCard | null;
  libraryError: string | null;
  /** The picked entity's mirror rows; with `admin`, the card can act on it. */
  entity?: SelectedEntity | null;
  admin?: AdminSender;
}): React.JSX.Element {
  // Last answer per field ("Health.current") and for the action buttons ("action").
  const [results, setResults] = React.useState<Record<string, AdminOutcome & { label?: string }>>({});
  const wireId = card?.wireId;
  React.useEffect(() => setResults({}), [wireId]);
  const note = (key: string, out: AdminOutcome, label?: string): void => setResults((r) => ({ ...r, [key]: { ...out, label } }));
  const live = admin && entity && entity.wireId.toString() === wireId ? { admin, entity } : null;
  if (!card) {
    return (
      <p className="text-muted-foreground" data-testid="selection-empty">
        Point at an entity in the view and left-click it to pick it (Esc frees the mouse).
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="selection-card">
      <div>
        <span className="font-medium text-foreground">{card.name ?? card.kind}</span>{" "}
        <span className="text-muted-foreground">
          {card.name ? `${card.kind} · ` : ""}#{card.wireId}
        </span>
      </div>
      {live && <EntityActions entity={live.entity} admin={live.admin} onResult={(label, out) => note("action", out, label)} />}
      {results.action && (
        <pre
          className={`max-h-40 overflow-auto whitespace-pre-wrap font-mono ${results.action.ok ? "text-muted-foreground" : "text-destructive"}`}
          data-testid="selection-action-result"
        >
          {results.action.label} → {results.action.message}
        </pre>
      )}
      {card.asset && (
        <section>
          <h4 className="text-[10px] uppercase tracking-wide text-muted-foreground">PICG asset</h4>
          <p>
            <span className="text-foreground">{card.asset.displayName}</span>{" "}
            <span className="font-mono text-muted-foreground">{card.asset.graph}</span>
          </p>
          <p className="text-muted-foreground">
            variant {card.asset.variant} → shape {card.asset.shape + 1} of {card.asset.variants} · seed{" "}
            <span className="font-mono">{card.asset.seed}</span>
          </p>
          {card.asset.description && <p className="text-muted-foreground">{card.asset.description}</p>}
          {card.asset.error && <p className="text-red-400">{card.asset.error}</p>}
          {card.asset.parameters.length > 0 && (
            <DataTable
              headless
              className="mt-1 w-full font-mono"
              rows={card.asset.parameters}
              rowKey={(p) => p.name}
              rowTitle={(p) => p.description ?? `${p.type}${p.range ? `, ${p.range}` : ""}`}
              columns={[
                { id: "name", cell: (p) => <span className="text-muted-foreground">{p.name}</span> },
                {
                  id: "value",
                  cell: (p) => (
                    <>
                      {p.value}
                      {p.overridden && <span className="ml-1 text-amber-300" title={`graph default ${p.default}`}>●</span>}
                    </>
                  ),
                },
                { id: "range", cell: (p) => <span className="text-muted-foreground">{p.range ?? ""}</span> },
              ]}
            />
          )}
        </section>
      )}
      {card.unknownAsset && (
        <p className="text-amber-300">
          AssetRef {card.unknownAsset.assetHash} (variant {card.unknownAsset.variant}) is not in the PICG library
          {libraryError ? ` (library: ${libraryError})` : ""}.
        </p>
      )}
      {card.components.map((c) => (
        <section key={c.name}>
          <h4 className="text-[10px] uppercase tracking-wide text-muted-foreground">{c.name}</h4>
          <DataTable
            headless
            className="w-full font-mono"
            rows={c.fields}
            rowKey={(f) => f.key}
            columns={[
              { id: "key", cell: (f) => <span className="text-muted-foreground">{f.key}</span> },
              {
                id: "value",
                cellClass: () => "break-all",
                interactive: !!live,
                cell: (f) =>
                  live && editableField(c.name, f.key) ? (
                    <EditableValue
                      value={f.value}
                      label={`${c.name}.${f.key}`}
                      onCommit={(text) =>
                        void sendAdmin(live.admin, setCommand(card.wireId, c.name, f.key, text)).then((out) => note(`${c.name}.${f.key}`, out))
                      }
                    />
                  ) : (
                    f.value
                  ),
              },
              {
                id: "result",
                cell: (f) => {
                  const r = results[`${c.name}.${f.key}`];
                  return r ? (
                    <span className={r.ok ? "text-emerald-400" : "text-destructive"} title={r.message}>
                      {r.ok ? "✓" : r.message}
                    </span>
                  ) : null;
                },
              },
            ]}
          />
        </section>
      ))}
    </div>
  );
}
