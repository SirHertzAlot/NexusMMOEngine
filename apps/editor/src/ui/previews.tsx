/**
 * Shared UI state for the shell: the small external store, the Art & audio
 * selection, and the deep links (#/workspace/view/selection) that read and
 * write the selection stores.
 */

import * as React from "react";
import { MIcon, TreeItem, notify } from "./components.js";
import { assetUiStore, setAssetFilter, setAssetPreview, useAssetManifest } from "./asset-inspector.js";
import { editorSelection } from "./editor-selection.js";

// ---------------------------------------------------------------- shared UI state
// Doc §3.1: selection is a shared model, not panel state — picking in any
// view feeds every inspector. These tiny external stores are the shell's
// UI-only version of that: selection + local drafts. Nothing here touches
// the simulation; backend slices replace the sample data one-for-one.

interface Listener {
  (): void;
}

export function createStore<T>(initial: T): {
  get: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  subscribe: (fn: () => void) => () => void;
  use: () => T;
} {
  let value = initial;
  const listeners = new Set<Listener>();
  const subscribe = (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };
  return {
    get: () => value,
    set: (next) => {
      value = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      listeners.forEach((l) => l());
    },
    subscribe,
    use: () => React.useSyncExternalStore(subscribe, () => value),
  };
}

/** Subscribe to every selection store (drives hash sync; one call). */
export function subscribeDeepSelection(fn: () => void): () => void {
  const unsubs = [artStore].map((s) => s.subscribe(fn));
  const unsubSel = editorSelection.subscribe(fn);
  return () => {
    unsubs.forEach((u) => u());
    unsubSel();
  };
}

type Tone = "ok" | "err" | "warn" | "info" | "plain";

const TONES: Record<Tone, { background: string; color: string }> = {
  ok: { background: "rgba(156,214,125,.14)", color: "#9CD67D" },
  err: { background: "rgba(255,180,171,.14)", color: "#FFB4AB" },
  warn: { background: "rgba(232,163,61,.16)", color: "#E8A33D" },
  info: { background: "rgba(185,195,255,.14)", color: "#B9C3FF" },
  plain: { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" },
};

export function Pill({ tone = "plain", children }: { tone?: Tone; children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold"
      style={TONES[tone]}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------- art & audio (EA21, EA22, EA24)

/**
 * What is selected in Art & audio's Animation, VFX and Audio views (deep links
 * `clip:`, `move:`, `effect:`, `event:`), and the lists their left dock shows
 * (the open panel publishes them). The panels are ui/media-*.tsx.
 */
export const artStore = createStore({
  clip: "",
  move: 1,
  effect: "embers",
  event: "hit",
  animTab: "locomotion" as "clips" | "locomotion" | "combat",
  vfxTab: "effects" as "effects" | "tiers" | "materials",
  clips: [] as string[],
  moves: [] as Array<[number, string]>,
  effects: [] as string[],
  events: [] as Array<[string, string]>,
});

/** Left library for the assets view: the pack's models and textures (the other views use media-tree.tsx). */
export function ArtAudioTree({ onView }: { onView?: (view: string) => void }): React.JSX.Element {
  return <AssetLibraryTree onView={onView} />;
}

/** Library dock for the assets view: manifest groups with counts, a dock
 *  search that filters the panel's model table, and model picks that
 *  preview in the panel — same shared store, both directions. */
function AssetLibraryTree({ onView }: { onView?: (view: string) => void }): React.JSX.Element {
  const { scan, loading, refresh } = useAssetManifest();
  const { filter, previewId } = assetUiStore.use();
  const [open, setOpen] = React.useState<string[]>(["models"]);
  const toggle = (id: string): void => setOpen((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const models = scan?.manifest?.models ?? [];
  const textures = scan?.manifest?.textures ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = models.filter((m) => needle === "" || m.id.toLowerCase().includes(needle)).slice(0, 12);
  const group = (id: string, label: string, trailing: string, kids: React.ReactNode): React.JSX.Element => (
    <div key={id} className="mb-1">
      <TreeItem
        icon="folder" label={label} trailing={trailing}
        hasKids expanded={open.includes(id)} onToggle={() => toggle(id)}
        selected={false} onPick={() => toggle(id)}
        menu={[
          { label: "Rescan pack", icon: "refresh", run: () => void refresh() },
          "sep",
          { label: "Reveal in file browser", icon: "folder_open", stagedFor: "EA · art & audio" },
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
          onChange={(e) => setAssetFilter(e.target.value)}
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
            <TreeItem
              key={m.id} icon="description" label={m.id} depth={1} mono
              selected={m.id === previewId}
              onPick={() => setAssetPreview(m.id)}
              menu={[
                { label: `Preview ${m.id}`, icon: "visibility", run: () => setAssetPreview(m.id) },
                "sep",
                { label: "Reveal in file browser", icon: "folder_open", stagedFor: "EA · art & audio" },
              ]}
            />
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
            <TreeItem
              key={t.id} icon="image" label={t.id} depth={1} mono
              menu={[{ label: "Reveal in file browser", icon: "folder_open", stagedFor: "EA · art & audio" }]}
              onPick={() => notify(`${t.id} — texture preview arrives with the art pipeline slice`)}
            />
          ))}
        </>
      ))}
      <button
        onClick={() => (onView ? onView("audio") : notify("Audio events — open the Audio view"))}
        className="m3-focus flex h-9 w-full items-center gap-3 rounded-full px-3 text-left text-sm"
        style={{ color: "var(--m3-on-surface)" }}
      >
        <MIcon name="audio_file" size={19} />Audio
        <span className="ml-auto text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>events →</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- deep links & ECS base
// Everything deep-links: the shell encodes workspace + view + selection in
// the URL hash, and every inspector drills to the ECS base — the engine's
// building blocks. Selection state stays in the shared stores; this
// section only translates between stores and hash keys.

/** Read the current deep selection for a workspace view (null = none). */
export function readDeepSelection(workspace: string, view: string): string | null {
  if (workspace === "scenes" && view === "scene") {
    const sel = editorSelection.get();
    if (!sel || !sel.id) return null;
    if (sel.kind === "scene" || sel.kind === "scene-node") return `scene:${sel.id}`;
    return null;
  }
  if (workspace === "dungeons" && view === "dungeons") {
    const sel = editorSelection.get();
    if (!sel || !sel.id) return null;
    if (sel.kind === "dungeon-room") return `dungeon-room:${sel.id}`;
    if (sel.kind === "dungeon-spawn") return `dungeon-spawn:${sel.id}`;
    if (sel.kind === "dungeon-prop") return `dungeon-prop:${sel.id}`;
    return null;
  }
  if (workspace === "scene" && view === "ecs") {
    const sel = editorSelection.get();
    if (sel && sel.kind === "entity" && sel.id) return `entity:${sel.id}`;
    return null;
  }
  switch (`${workspace}/${view}`) {
    case "artaudio/animation": {
      const a = artStore.get();
      return a.animTab === "combat" ? `move:${a.move}` : a.clip ? `clip:${a.clip}` : null;
    }
    case "artaudio/vfx":
      return `effect:${artStore.get().effect}`;
    case "artaudio/audio":
      return `event:${artStore.get().event}`;
    default:
      return null;
  }
}

/** Apply a deep-selection key; returns the workspace/view it implies. */
export function applyDeepSelection(sel: string): { workspace: string; view: string } | null {
  const i = sel.indexOf(":");
  if (i < 0) return null;
  const kind = sel.slice(0, i);
  const rest = sel.slice(i + 1);
  switch (kind) {
    case "clip":
      if (!rest) return null;
      artStore.set((p) => ({ ...p, clip: rest, animTab: "clips" }));
      return { workspace: "artaudio", view: "animation" };
    case "move":
      if (!Number.isInteger(Number(rest))) return null;
      artStore.set((p) => ({ ...p, move: Number(rest), animTab: "combat" }));
      return { workspace: "artaudio", view: "animation" };
    case "effect":
      if (!rest) return null;
      artStore.set((p) => ({ ...p, effect: rest, vfxTab: "effects" }));
      return { workspace: "artaudio", view: "vfx" };
    case "event":
      if (!rest) return null;
      artStore.set((p) => ({ ...p, event: rest }));
      return { workspace: "artaudio", view: "audio" };
    case "scene": {
      if (!rest) return null;
      const slash = rest.indexOf("/");
      const kind = slash >= 0 ? "scene-node" : "scene";
      editorSelection.select({
        source: "outliner",
        kind,
        id: rest,
        label: rest,
        components: [{ name: "Scene", fields: [{ key: "name", value: rest }] }],
      });
      return { workspace: "scenes", view: "scene" };
    }
    case "dungeon-room":
    case "dungeon-spawn":
    case "dungeon-prop": {
      if (!rest) return null;
      const dungeonKind = kind as "dungeon-room" | "dungeon-spawn" | "dungeon-prop";
      editorSelection.select({
        source: "outliner",
        kind: dungeonKind,
        id: rest,
        label: rest,
        components: [{ name: "Dungeon", fields: [{ key: "id", value: rest }] }],
      });
      return { workspace: "dungeons", view: "dungeons" };
    }
    case "entity": {
      if (!rest) return null;
      editorSelection.select({
        source: "entity-list",
        kind: "entity",
        id: rest,
        label: rest,
        components: [],
      });
      return { workspace: "scene", view: "ecs" };
    }
    default:
      return null;
  }
}
