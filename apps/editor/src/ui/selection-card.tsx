/**
 * Selection card panel (ROADMAP E6): renders inspectors/selection.ts's
 * card for the entity picked in the game view. Presentation only; the
 * view-model does the work.
 */

import * as React from "react";
import { DataTable } from "./data-table.js";
import type { SelectionCard } from "../inspectors/selection.js";
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

export function SelectionCardView({ card, libraryError }: { card: SelectionCard | null; libraryError: string | null }): React.JSX.Element {
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
              { id: "value", cellClass: () => "break-all", cell: (f) => f.value },
            ]}
          />
        </section>
      ))}
    </div>
  );
}
