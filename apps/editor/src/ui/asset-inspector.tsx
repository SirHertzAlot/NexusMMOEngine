/**
 * Art asset pipeline inspector — scan, validate, and preview the pack.
 *
 * Folder convention (see docs/EDITOR.md §art):
 *   assets/
 *     manifest.json          — optional; the pack descriptor
 *     models/                — .glb / .gltf
 *     textures/              — .png / .jpg / .webp
 *
 * The panel shows the host-side scan (manifest entries + validation
 * diagnostics from @mmo-engine/art) and can load the pack in the
 * browser through ManifestAssetProvider, reporting per-model
 * loaded/fallback status. Missing or broken art never breaks the
 * pipeline — placeholders cover every gap, and the diagnostics say
 * exactly what to fix.
 */

import * as React from "react";
import { ManifestAssetProvider, type AssetManifest, type AssetLoadStatus } from "@mmo-engine/art/browser";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SectionTitle,
} from "./components.js";
import { ModelPreview } from "./model-preview.js";
import { createStore } from "./previews.js";

/** Shared asset-browser UI: the dock search filters the panel's model
 *  table, and picking a model previews it in the panel. */
export interface AssetUiState {
  filter: string;
  previewId: string | null;
}

export const assetUiStore = createStore<AssetUiState>({ filter: "", previewId: null });

export function setAssetFilter(filter: string): void {
  assetUiStore.set((p) => ({ ...p, filter }));
}

export function setAssetPreview(previewId: string | null): void {
  assetUiStore.set((p) => ({ ...p, previewId }));
}

/** Host-side pack scan, shared by the panel and the library dock so both
 *  read one fetch. Refresh on demand (rescan). */
export function useAssetManifest(): { scan: AssetScan | null; loading: boolean; refresh: () => void } {
  const [scan, setScan] = React.useState<AssetScan | null>(null);
  const [loading, setLoading] = React.useState(false);
  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/editor/assets");
      setScan((await res.json()) as AssetScan);
    } catch (err) {
      setScan({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);
  return { scan, loading, refresh };
}

/** Table rows rendered at once (converted packs list thousands of models). */
const MAX_ROWS = 200;
/** Models the browser load test fetches in one go. */
const MAX_LOAD_TEST = 100;

interface AssetScan {
  ok: boolean;
  root?: string;
  manifest?: AssetManifest | null;
  diagnostics?: string[];
  error?: string;
}

export function AssetInspectorPanel(): React.JSX.Element {
  const { scan, loading, refresh } = useAssetManifest();
  const [fallbacks, setFallbacks] = React.useState<AssetLoadStatus[] | null>(null);
  const [packLoading, setPackLoading] = React.useState(false);
  const { filter, previewId } = assetUiStore.use();

  async function loadPackInBrowser(): Promise<void> {
    if (!scan?.manifest || !loadable) return;
    setPackLoading(true);
    try {
      // Load-test only the filtered models: converted packs hold thousands,
      // and loading them all at once would stall the tab.
      const provider = new ManifestAssetProvider({
        baseUrl: "/assets",
        manifest: { ...scan.manifest, models: matching, textures: [] },
      });
      await provider.loadAssetPack("/assets");
      setFallbacks(provider.fallbackStatus());
    } finally {
      setPackLoading(false);
    }
  }

  const manifest = scan?.manifest ?? null;
  const diagnostics = scan?.diagnostics ?? [];
  const needle = filter.trim().toLowerCase();
  const matching = (manifest?.models ?? []).filter(
    (m) => needle === "" || m.id.toLowerCase().includes(needle),
  );
  const loadable = matching.length > 0 && matching.length <= MAX_LOAD_TEST;
  const previewFile = manifest?.models.find((m) => m.id === previewId)?.file ?? null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Art Asset Pipeline</CardTitle>
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? "Scanning…" : "↻ Rescan"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {scan && !scan.ok && (
            <p className="text-xs text-red-400">{scan.error}</p>
          )}
          <p className="text-xs text-muted-foreground">
            Pack root: <span className="font-mono">{scan?.root ?? "…"}</span>
          </p>

          {manifest ? (
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold">{manifest.name}</p>
              <Badge tone="info">v{manifest.version}</Badge>
              <Badge tone="ok">{manifest.models.length} models</Badge>
              <Badge tone="ok">{manifest.textures.length} textures</Badge>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No manifest yet — drop art into{" "}
              <span className="font-mono">assets/models/</span> and{" "}
              <span className="font-mono">assets/textures/</span>, then rescan
              to generate one.
            </p>
          )}

          {manifest && (
            <>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <SectionTitle>
                    Models ({matching.length} of {manifest.models.length})
                  </SectionTitle>
                  <input
                    value={filter}
                    onChange={(e) => setAssetFilter(e.target.value)}
                    placeholder="filter, e.g. fantasy-kingdom/SM_Prop"
                    className="h-8 w-72 rounded-md border border-input bg-background px-2 text-xs"
                  />
                </div>
                {previewFile && <ModelPreview url={`/assets/${previewFile}`} />}
                <ModelTable
                  selected={previewId}
                  onSelect={setAssetPreview}
                  rows={matching.slice(0, MAX_ROWS).map((m) => ({
                    id: m.id,
                    file: m.file,
                    extra: m.forShape ? `shape: ${m.forShape}` : "",
                  }))}
                />
                {matching.length > MAX_ROWS && (
                  <p className="text-xs text-muted-foreground">
                    Showing the first {MAX_ROWS} — narrow the filter to see more.
                  </p>
                )}
              </div>
              <div>
                <SectionTitle>Textures</SectionTitle>
                <ModelTable
                  rows={manifest.textures.map((t) => ({
                    id: t.id,
                    file: t.file,
                    extra: "",
                  }))}
                />
              </div>
            </>
          )}

          <div>
            <div className="flex items-center justify-between">
              <SectionTitle>Browser load test</SectionTitle>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void loadPackInBrowser()}
                disabled={!manifest || packLoading || !loadable}
                title={loadable ? undefined : `Filter to at most ${MAX_LOAD_TEST} models first`}
              >
                {packLoading ? "Loading…" : `Load ${Math.min(matching.length, MAX_LOAD_TEST)} in browser`}
              </Button>
            </div>
            {fallbacks ? (
              <ul className="mt-2 space-y-1 text-xs">
                {fallbacks.map((f) => (
                  <li key={f.id} className="flex items-center gap-2">
                    <Badge tone={f.status === "loaded" ? "ok" : "warn"}>
                      {f.status}
                    </Badge>
                    <span className="font-mono">{f.id}</span>
                    {f.diagnostic && (
                      <span className="text-muted-foreground">{f.diagnostic}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                Loads the filtered models (at most 100) through the real provider — failures stay on
                placeholder fallback and are reported per asset.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Diagnostics</CardTitle>
        </CardHeader>
        <CardContent>
          {diagnostics.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No diagnostics — the pack validates cleanly.
            </p>
          ) : (
            <ul className="space-y-2 text-xs">
              {diagnostics.map((d, i) => (
                <li
                  key={i}
                  className="rounded-md border border-yellow-900 bg-yellow-950/40 p-2 text-yellow-200"
                >
                  {d}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4">
            <SectionTitle>Convention</SectionTitle>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              <li>
                <span className="font-mono">assets/manifest.json</span> —
                validated with Zod; paths must stay inside the pack (no{" "}
                <span className="font-mono">..</span>, no absolute paths).
              </li>
              <li>
                <span className="font-mono">assets/models/*.glb</span> — entity
                bodies; optional <span className="font-mono">forShape</span>{" "}
                tag maps a model to a BodyConfig shape.
              </li>
              <li>
                <span className="font-mono">assets/textures/*</span> — png / jpg
                / webp.
              </li>
              <li>
                Missing art never breaks anything: placeholders render and the
                diagnostics say what to add.
              </li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ModelTable({
  rows,
  selected,
  onSelect,
}: {
  rows: Array<{ id: string; file: string; extra: string }>;
  selected?: string | null;
  onSelect?: (id: string) => void;
}): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <p className="mt-1 text-xs italic text-muted-foreground">— none —</p>
    );
  }
  return (
    <table className="mt-1 w-full text-xs">
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.id}
            onClick={onSelect ? () => onSelect(r.id) : undefined}
            className={
              "border-b border-border/50 last:border-0" +
              (onSelect ? " cursor-pointer hover:bg-accent" : "") +
              (selected === r.id ? " bg-accent" : "")
            }
          >
            <td className="py-1 pr-3 font-mono font-semibold">{r.id}</td>
            <td className="py-1 font-mono text-muted-foreground">{r.file}</td>
            <td className="py-1 text-right text-muted-foreground">{r.extra}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
