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

interface AssetScan {
  ok: boolean;
  root?: string;
  manifest?: AssetManifest | null;
  diagnostics?: string[];
  error?: string;
}

export function AssetInspectorPanel(): React.JSX.Element {
  const [scan, setScan] = React.useState<AssetScan | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [fallbacks, setFallbacks] = React.useState<AssetLoadStatus[] | null>(null);
  const [packLoading, setPackLoading] = React.useState(false);

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

  async function loadPackInBrowser(): Promise<void> {
    if (!scan?.manifest) return;
    setPackLoading(true);
    try {
      const provider = new ManifestAssetProvider({
        baseUrl: "/assets",
        manifest: scan.manifest,
      });
      await provider.loadAssetPack("/assets");
      setFallbacks(provider.fallbackStatus());
    } finally {
      setPackLoading(false);
    }
  }

  const manifest = scan?.manifest ?? null;
  const diagnostics = scan?.diagnostics ?? [];

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
              <div>
                <SectionTitle>Models</SectionTitle>
                <ModelTable
                  rows={manifest.models.map((m) => ({
                    id: m.id,
                    file: m.file,
                    extra: m.forShape ? `shape: ${m.forShape}` : "",
                  }))}
                />
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
                disabled={!manifest || packLoading}
              >
                {packLoading ? "Loading…" : "Load pack in browser"}
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
                Loads every model through the real provider — failures stay on
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
}: {
  rows: Array<{ id: string; file: string; extra: string }>;
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
          <tr key={r.id} className="border-b border-border/50 last:border-0">
            <td className="py-1 pr-3 font-mono font-semibold">{r.id}</td>
            <td className="py-1 font-mono text-muted-foreground">{r.file}</td>
            <td className="py-1 text-right text-muted-foreground">{r.extra}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
