/**
 * AssetPreview — render a 3D preview for an asset ID or URL.
 *
 * Takes either:
 * - `assetId`: a manifest model/texture ID, resolved via
 *   GET /api/editor/assets/resolve?id=… to a servable URL
 * - `url`: a direct URL to a .glb/.gltf file
 *
 * Renders through the existing ModelPreview (orbit controls, auto-fit,
 * scale grid) — this component only adds the ID→URL resolution layer.
 */

import * as React from "react";
import { ModelPreview } from "./model-preview.js";
import { RigPreview } from "./rig-preview.js";

export interface AssetPreviewProps {
  /** Manifest asset ID (e.g. "goblin"). Resolved via the editor host. */
  assetId?: string;
  /** Direct URL to a .glb/.gltf. Used as-is when assetId is absent. */
  url?: string;
  /** Optional label shown above the preview. */
  label?: string;
  /** Show the animal's procedural rig (WL2 rig view) instead of the plain model. */
  rig?: boolean;
}

export function AssetPreview({ assetId, url, label, rig }: AssetPreviewProps): React.JSX.Element {
  const [resolvedUrl, setResolvedUrl] = React.useState<string | null>(url ?? null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (url) {
      setResolvedUrl(url);
      setError(null);
      return;
    }
    if (!assetId) {
      setResolvedUrl(null);
      setError("no asset specified");
      return;
    }
    let cancelled = false;
    setResolvedUrl(null);
    setError(null);
    fetch(`/api/editor/assets/resolve?id=${encodeURIComponent(assetId)}`)
      .then(async (res) => {
        const body = (await res.json()) as { ok: boolean; url?: string; error?: string };
        if (cancelled) return;
        if (body.ok && body.url) {
          setResolvedUrl(body.url);
        } else {
          setError(body.error ?? "asset not found");
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [assetId, url]);

  if (error) {
    return (
      <div className="rounded-md border border-input p-4 text-sm text-muted-foreground">
        {label ? <div className="mb-1 font-medium">{label}</div> : null}
        <div>Preview unavailable: {error}</div>
      </div>
    );
  }
  if (!resolvedUrl) {
    return (
      <div className="rounded-md border border-input p-4 text-sm text-muted-foreground">
        {label ? <div className="mb-1 font-medium">{label}</div> : null}
        <div>Resolving asset…</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {label ? <div className="text-sm font-medium">{label}</div> : null}
      {rig ? <RigPreview url={resolvedUrl} modelName={resolvedUrl.split("/").pop() ?? resolvedUrl} /> : <ModelPreview url={resolvedUrl} />}
    </div>
  );
}
