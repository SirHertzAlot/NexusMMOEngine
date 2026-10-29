/**
 * Library dock for the Art Assets view: manifest groups with counts, a dock
 * search that filters the panel's model table, and model picks that preview
 * in the panel (the same shared store, both directions).
 */

import * as React from "react";
import { MIcon, TreeItem } from "./components.js";
import { assetUiStore, setAssetFilter, setAssetPreview, useAssetManifest } from "./asset-inspector.js";

export function AssetLibraryTree(): React.JSX.Element {
  const { scan, loading, refresh } = useAssetManifest();
  const { filter, previewId } = assetUiStore.use();
  const [open, setOpen] = React.useState<string[]>(["models"]);
  const toggle = (id: string): void => setOpen((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const models = scan?.manifest?.models ?? [];
  const textures = scan?.manifest?.textures ?? [];
  const deferredFilter = React.useDeferredValue(filter);
  const needle = deferredFilter.trim().toLowerCase();
  const shown = models.filter((m) => needle === "" || m.id.toLowerCase().includes(needle)).slice(0, 12);
  const group = (id: string, label: string, trailing: string, kids: React.ReactNode): React.JSX.Element => (
    <div key={id} className="mb-1">
      <TreeItem
        icon="folder" label={label} trailing={trailing}
        hasKids expanded={open.includes(id)} onToggle={() => toggle(id)}
        selected={false} onPick={() => toggle(id)}
        menu={[
          { label: "Rescan pack", icon: "refresh", run: () => void refresh() },
        ]}
      />
      {open.includes(id) && kids}
    </div>
  );
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 px-1">
        <MIcon name="search" size={17} />
        <input
          value={filter}
          onChange={(e) => React.startTransition(() => setAssetFilter(e.target.value))}
          placeholder="Filter models…"
          aria-label="Filter asset models"
          className="m3-focus h-8 min-w-0 flex-1 rounded-lg border bg-transparent px-2 font-mono text-xs"
          style={{ borderColor: "var(--m3-outline-variant)", color: "var(--m3-on-surface)" }}
        />
      </div>
      {group("pack", scan?.manifest?.name ?? "Art pack", scan?.manifest ? `v${scan.manifest.version}` : loading ? "…" : "missing", (
        <>
          <p className="px-3 py-1 pl-11 font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>
            {scan?.manifest ? `${models.length} models · ${textures.length} textures` : "drop art into assets/, then rescan"}
          </p>
          <button
            onClick={() => void refresh()}
            className="m3-focus ml-11 flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium"
            style={{ background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" }}
          >
            <MIcon name="refresh" size={15} />{loading ? "Scanning…" : "Rescan"}
          </button>
        </>
      ))}
      {group("models", "Models", String(models.length), (
        <>
          {shown.map((m) => (
            <div style={{ containIntrinsicSize: "0 120px", contentVisibility: "auto" }}>
              <TreeItem
              key={m.id} icon="description" label={m.id} depth={1} mono
              selected={m.id === previewId}
              onPick={() => setAssetPreview(m.id)}
              menu={[
                { label: `Preview ${m.id}`, icon: "visibility", run: () => setAssetPreview(m.id) },
              ]}
            />
            </div>
          ))}
          {models.length > shown.length && (
            <p className="px-3 py-1 pl-11 font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>
              +{models.length - shown.length} more — narrow the filter
            </p>
          )}
        </>
      ))}
      {group("textures", "Textures", String(textures.length), (
        <>
          {textures.slice(0, 12).map((t) => (
            <div style={{ containIntrinsicSize: "0 80px", contentVisibility: "auto" }}>
              <TreeItem
              key={t.id} icon="image" label={t.id} depth={1} mono
            />
            </div>
          ))}
        </>
      ))}
    </div>
  );
}
