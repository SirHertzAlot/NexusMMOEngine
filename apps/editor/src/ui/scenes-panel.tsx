/**
 * Scenes workspace (roadmap EA4): open a scene from content/scenes, edit
 * its node tree (Outliner) and the selected node's fields and components
 * (Details), undo and redo, save and reload. Saves go through the host,
 * which validates and refuses (writing nothing) with every problem by path.
 */

import * as React from "react";
import {
  COMPONENTS,
  History,
  NODE_KINDS,
  SCENE_KINDS,
  addComponent,
  addNode,
  emptyScene,
  findNode,
  moveNode,
  removeComponent,
  removeNode,
  setComponentField,
  setNodeProp,
  setTransform,
  validateScene,
  type FieldSpec,
  type SceneDoc,
  type SceneIssue,
  type SceneKind,
  type SceneNode,
  type Vec3,
} from "@mmo-engine/scene";
import { keepLiveTransform, liveTransform, placePrefab, type LiveTransform } from "@mmo-engine/scene";
import { clearOverride, prefabFromNodes } from "@mmo-engine/scene";
import { GameplaySaveError, loadGameplay, saveGameplayRemote, type GameplayIssue } from "../gameplay-client.js";
import { prefabNames, prefabOf, prefabTableContent } from "../scene-prefab.js";
import { SceneSaveError, getScene, listScenes, saveScene } from "../scenes-client.js";
import { onNewSceneRequest, openScene, takeNewSceneRequest } from "../open-scene.js";
import { parentIdOf, withFreshIds } from "../scene-node-copy.js";
import { nodeSelection } from "../viewport-model.js";
import {
  NO_SELECTION,
  clickSelection,
  pruneSelection,
  selectOnly,
  selectionLabel,
  type SceneSelection,
} from "../scene-selection.js";
import { alignPositions, distributePositions, isMove, offsetPositions, positionDelta, type Axis, type AlignMode } from "../scene-align.js";
import { Button, Input, Label, NumberInput, SectionTitle, Select } from "./components.js";
import { OutlinerBadges } from "./outliner-badges-view.js";
import { AlignBar } from "./align-bar.js";
import { useDocActions } from "./doc-actions.js";
import { readClipboard, writeClipboard } from "./clipboard.js";
import { subscribeOpenAsset } from "./open-asset.js";
import { editorSelection, useEditorSelection, type SelectionSource } from "./editor-selection.js";
import { SceneViewport } from "./scene-viewport.js";
import { ScenePalette } from "./scene-palette.js";
import { MakePrefabDialog, PrefabInstanceCard } from "./make-prefab-dialog.js";

/** Scene names become file names: lowercase letters, digits and dashes, starting with a letter or digit. */
export const SCENE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Whether a prompted scene name may replace the document. */
export function isValidSceneName(name: string): boolean {
  return SCENE_NAME_RE.test(name);
}

/** Flatten the tree for display, keeping depth. */
function rows(list: SceneNode[], depth = 0): Array<{ node: SceneNode; depth: number }> {
  return list.flatMap((n) => [{ node: n, depth }, ...rows(n.children ?? [], depth + 1)]);
}

function nextId(doc: { nodes: SceneNode[] }, base: string): string {
  const used = new Set(rows(doc.nodes).map((r) => r.node.id));
  for (let i = 1; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

function FieldInput({ spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void }): React.JSX.Element {
  if (spec.type === "boolean") {
    return <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (spec.type === "enum") {
    return (
      <Select size="md" value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {spec.options.map((o) => <option key={o}>{o}</option>)}
      </Select>
    );
  }
  if (spec.type === "number") {
    return <NumberInput value={value as number} onChange={onChange} />;
  }
  return <Input className="h-9" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
}

export function ScenesPanel(): React.JSX.Element {
  const [hist] = React.useState(() => new History(emptyScene("untitled", "arena")));
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  const [names, setNames] = React.useState<string[]>([]);
  const [open, setOpen] = React.useState<string | null>(null);
  // EB2: a set, not one node. `primary` is what the gizmo rides and what
  // Details shows; the rest follow a drag and take part in align.
  const [sel, setSel] = React.useState<SceneSelection>(NO_SELECTION);
  const selected = sel.primary;
  const [issues, setIssues] = React.useState<SceneIssue[]>([]);
  const [status, setStatus] = React.useState("");
  // Inline "new scene" dialog (window.prompt is blocked in some webviews).
  const [naming, setNaming] = React.useState<string | null>(null);
  const [nameError, setNameError] = React.useState("");
  // Outliner context menu: {id, x, y} when open.
  const [ctx, setCtx] = React.useState<{ id: string; x: number; y: number } | null>(null);
  // Inline rename: node id being renamed.
  const [renaming, setRenaming] = React.useState<string | null>(null);
  // EB3: the prefabs table, read once so the panel can name what a node
  // places, say what it overrides, and add to it without dropping the rest.
  const [prefabTable, setPrefabTable] = React.useState<unknown>(null);
  const [making, setMaking] = React.useState(false);
  const [makeBusy, setMakeBusy] = React.useState(false);
  const [makeIssues, setMakeIssues] = React.useState<GameplayIssue[]>([]);
  const renameCancelled = React.useRef(false);
  const doc = hist.doc;
  const node = selected ? findNode(doc, selected) : undefined;

  // Selection is shared with the rest of the editor (editor-selection.ts):
  // picking in the viewport or the outliner publishes the node; a node
  // selected elsewhere selects it here. The last live entity selected in
  // play mode stays available to "Keep" after the selection moves on.
  const shared = useEditorSelection();
  const [live, setLive] = React.useState<{ label: string; t: LiveTransform } | null>(null);
  /** Publish a whole selection; the shared model follows its primary. */
  const selectSet = (next: SceneSelection, source: SelectionSource = "outliner"): void => {
    setSel(next);
    const n = next.primary ? findNode(hist.doc, next.primary) : undefined;
    if (n) editorSelection.select(nodeSelection(source, n));
    else editorSelection.clear();
  };
  const select = (id: string | null, source: SelectionSource = "outliner"): void => selectSet(selectOnly(id), source);
  /** The outliner's row order: what a shift-click ranges over. */
  const rowOrder = (): string[] => rows(hist.doc.nodes).map((r) => r.node.id);
  const clickNode = (
    id: string | null,
    mods: { additive: boolean; range: boolean },
    source: SelectionSource,
  ): void => {
    if (id === null) {
      if (!mods.additive && !mods.range) selectSet(NO_SELECTION, source);
      return;
    }
    selectSet(clickSelection(sel, rowOrder(), id, mods), source);
  };
  React.useEffect(() => {
    if (!shared) return;
    if (shared.kind === "scene-node") {
      if (shared.id !== selected && findNode(hist.doc, shared.id)) setSel(selectOnly(shared.id));
      return;
    }
    const t = liveTransform(shared.components);
    if (t) setLive({ label: shared.label, t });
  }, [shared]);
  // Play mode runs the open scene, saved or not (open-scene.ts).
  React.useEffect(() => {
    openScene.set(open ? { name: open, doc } : null);
  }, [open, doc]);

  const run = (label: string, fn: Parameters<History["apply"]>[1]): void => {
    try {
      hist.apply(label, fn);
      setIssues(validateScene(hist.doc));
      setStatus("");
    } catch (e) {
      setStatus((e as Error).message);
    }
    bump();
  };
  // Context menu actions (also wired to the Edit menu via DocActions).
  const duplicateNode = (id: string): void => {
    const n = findNode(hist.doc, id);
    if (!n) return;
    // Fresh ids for the whole subtree, placed beside the original (same parent).
    const copy = withFreshIds(hist.doc, n);
    const parent = parentIdOf(hist.doc, id);
    run("duplicate node", (d) => addNode(d, parent, copy));
    select(copy.id);
  };
  const deleteNode = (id: string): void => {
    run("delete node", (d) => removeNode(d, id));
    setSel((cur) => pruneSelection({ ...cur, ids: cur.ids.filter((x) => x !== id) }, (x) => Boolean(findNode(hist.doc, x))));
    if (selected === id) select(null);
  };
  /** Delete every selected node in one undo step (EB2). */
  const deleteSelection = (): void => {
    const ids = sel.ids;
    if (ids.length === 0) return;
    run(ids.length === 1 ? "delete node" : `delete ${ids.length} nodes`, (d) => ids.reduce((acc, id) => removeNode(acc, id), d));
    select(null);
  };
  /** Each selected node's own position, which is what align and distribute move. */
  const selectedPositions = (): Record<string, [number, number, number]> => {
    const out: Record<string, [number, number, number]> = {};
    for (const id of sel.ids) {
      const n = findNode(hist.doc, id);
      if (n) out[id] = [...(n.transform?.position ?? [0, 0, 0])] as [number, number, number];
    }
    return out;
  };
  const applyPositions = (label: string, moved: Record<string, [number, number, number]>): void => {
    const ids = Object.keys(moved);
    if (ids.length === 0) return;
    run(label, (d) => ids.reduce((acc, id) => setTransform(acc, id, { position: moved[id] }), d));
  };
  const alignSelection = (axis: Axis, mode: AlignMode): void =>
    applyPositions(`align ${mode}`, alignPositions(selectedPositions(), axis, mode));
  const distributeSelection = (axis: Axis): void =>
    applyPositions("distribute", distributePositions(selectedPositions(), axis));
  const refresh = (): void => void listScenes().then(setNames, (e: Error) => setStatus(e.message));
  React.useEffect(refresh, []);
  // The prefabs the project already has. A failed read is not an error the
  // Scenes workspace reports — it only means "Make prefab" cannot say what
  // would clash, so the button waits rather than offering a name twice.
  const readPrefabs = React.useCallback(() => {
    void loadGameplay().then(
      (snapshot) => setPrefabTable(snapshot.tables.prefabs),
      () => setPrefabTable(null),
    );
  }, []);
  React.useEffect(readPrefabs, [readPrefabs]);

  /**
   * EB3: the chosen nodes become a prefab, and the scene keeps one node
   * that places it. The file is written first, through the prefabs data
   * table, so a refusal leaves the scene alone; the scene edit then goes
   * through history like any other, undoable.
   */
  const makePrefab = async (name: string): Promise<void> => {
    setMakeBusy(true);
    setMakeIssues([]);
    try {
      const authored = prefabFromNodes(hist.doc, sel.ids, name);
      const content = prefabTableContent(prefabTable, authored.prefab);
      await saveGameplayRemote("prefabs", content);
      setPrefabTable(content);
      run(`make prefab ${name}`, () => authored.doc);
      select(authored.id);
      setMaking(false);
      setStatus(`prefab "${name}" written; ${authored.took.length} node${authored.took.length === 1 ? "" : "s"} replaced by one that places it`);
    } catch (e) {
      if (e instanceof GameplaySaveError) setMakeIssues(e.issues);
      else setMakeIssues([{ file: `${name}.prefab.json`, path: "", message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setMakeBusy(false);
    }
  };

  // Toolbar Save/Undo/Redo target while a scene is open.
  useDocActions(() => {
    if (!open) return null;
    const pasteNode = (parentId: string | null): void => {
      const data = readClipboard("scene-node") as SceneNode | null;
      if (!data) {
        setStatus("nothing to paste");
        return;
      }
      const node = withFreshIds(hist.doc, data);
      run("paste node", (d) => addNode(d, parentId, node));
      select(node.id);
    };
    return {
      label: `scene "${open}"`,
      canSave: hist.dirty,
      canUndo: hist.canUndo,
      canRedo: hist.canRedo,
      problems: issues.map((i) => ({ severity: "error" as const, where: i.path || "(scene)", message: i.message })),
      save,
      undo: () => {
        hist.undo();
        setIssues(validateScene(hist.doc));
        bump();
      },
      redo: () => {
        hist.redo();
        setIssues(validateScene(hist.doc));
        bump();
      },
      // Edit menu: the outliner selection is the clipboard unit.
      canCut: !!node,
      canCopy: !!node,
      canPaste: readClipboard("scene-node") !== null,
      canDuplicate: !!node,
      canDelete: !!node,
      canSelectAll: doc.nodes.length > 0,
      cut: () => {
        if (!node) return;
        writeClipboard("scene-node", node);
        run("cut node", (d) => removeNode(d, node.id));
        select(null);
      },
      copy: () => {
        if (!node) return;
        writeClipboard("scene-node", node);
        setStatus(`copied ${node.id}`);
      },
      paste: () => pasteNode(selected),
      duplicate: () => {
        if (!node) return;
        const copy = withFreshIds(hist.doc, node);
        // Duplicate beside the original: same parent.
        const parent = parentIdOf(hist.doc, node.id);
        run("duplicate node", (d) => addNode(d, parent, copy));
        select(copy.id);
      },
      deleteSelection: () => {
        if (!node) return;
        run("delete node", (d) => removeNode(d, node.id));
        select(null);
      },
      selectAll: () => {
        const first = doc.nodes[0];
        if (first) select(first.id);
      },
      // File menu.
      canSaveAll: hist.dirty,
      canRevert: hist.dirty,
      canImport: true,
      canExport: true,
      saveAll: save,
      revert: () => {
        getScene(open).then(
          (d) => {
            hist.replace(d);
            setIssues(validateScene(d));
            setStatus(`reverted ${open}`);
            bump();
          },
          (e: Error) => setStatus(e.message),
        );
      },
      importFile: () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json";
        input.onchange = () => {
          const file = input.files?.[0];
          if (!file) return;
          file.text().then(
            (text) => {
              try {
                // The file may come from another scene's export; it takes the open
                // scene's name, since the host only saves a doc under its own name.
                const data = { ...(JSON.parse(text) as SceneDoc), name: open };
                const issues = validateScene(data);
                if (issues.length > 0) {
                  setIssues(issues);
                  setStatus("import refused: invalid scene");
                  return;
                }
                hist.replace(data);
                setIssues([]);
                setStatus(`imported ${file.name}`);
                bump();
              } catch {
                setStatus("import refused: not JSON");
              }
            },
            () => setStatus("import failed"),
          );
        };
        input.click();
      },
      exportFile: () => {
        const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${open}.scene.json`;
        a.click();
        // Revoking in the same task can cancel the download in some browsers.
        setTimeout(() => URL.revokeObjectURL(url), 0);
      },
    };
  });

  // The command palette asks us to open a specific scene by id.
  React.useEffect(
    () =>
      subscribeOpenAsset((req) => {
        if (req.kind === "scene") load(req.id);
      }, ["scene"]),
    [],
  );

  const load = (name: string): void => {
    getScene(name).then(
      (d) => {
        hist.replace(d);
        setOpen(name);
        setSel(NO_SELECTION);
        editorSelection.select({
          source: "outliner",
          kind: "scene",
          id: name,
          label: name,
          components: [{ name: "Scene", fields: [{ key: "name", value: name }] }],
        });
        setIssues(validateScene(d));
        setStatus(`opened ${name}`);
        bump();
      },
      (e: Error) => setStatus(e.message),
    );
  };
  const save = (): void => {
    if (!open) return;
    saveScene(open, doc).then(
      () => {
        hist.markSaved();
        setIssues([]);
        setStatus(`saved ${open}`);
        bump();
        refresh();
      },
      (e: Error) => {
        if (e instanceof SceneSaveError) setIssues(e.issues);
        setStatus(`${e.message} - nothing was written`);
      },
    );
  };
  const create = (): void => {
    setNaming("");
    setNameError("");
  };
  const confirmCreate = (): void => {
    const name = (naming ?? "").trim();
    if (!isValidSceneName(name)) {
      setNameError(`invalid scene name "${name}": use ^[a-z0-9][a-z0-9-]*$ (lowercase letters, digits and dashes, starting with a letter or digit)`);
      return;
    }
    hist.replace(emptyScene(name, "arena"));
    setOpen(name);
    setSel(NO_SELECTION);
    setIssues(validateScene(hist.doc));
    setNaming(null);
    setNameError("");
    bump();
  };

  // File → New Scene… lands here: now if the panel is mounted, on mount if not.
  const createRef = React.useRef(create);
  createRef.current = create;
  React.useEffect(() => {
    if (takeNewSceneRequest()) createRef.current();
    return onNewSceneRequest(() => {
      if (takeNewSceneRequest()) createRef.current();
    });
  }, []);

  const setVec = (key: "position" | "rotation" | "scale", i: number, v: number): void => {
    if (!node) return;
    const cur: Vec3 = [...(node.transform?.[key] ?? (key === "scale" ? [1, 1, 1] : [0, 0, 0]))] as Vec3;
    cur[i] = v;
    run("transform", (d) => setTransform(d, node.id, { [key]: cur }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2.5 text-[13px]" data-testid="scenes-panel">
      {naming !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-label="New scene">
          <div className="rounded-lg border p-4 shadow-lg" style={{ background: "var(--m3-surface)", borderColor: "var(--m3-outline-variant)" }}>
            <h3 className="mb-2 text-sm font-medium">New scene</h3>
            <input
              autoFocus
              className="mb-2 w-64 rounded border px-2 py-1 text-sm"
              style={{ borderColor: "var(--m3-outline)" }}
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmCreate();
                else if (e.key === "Escape") setNaming(null);
              }}
              placeholder="lowercase, digits, dashes"
              aria-label="Scene name"
            />
            {nameError && <p className="mb-2 text-xs" style={{ color: "var(--m3-error)" }}>{nameError}</p>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setNaming(null)}>Cancel</Button>
              <Button size="sm" onClick={confirmCreate}>Create</Button>
            </div>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Select size="md" value={open ?? ""} onChange={(e) => e.target.value && load(e.target.value)} aria-label="Open scene">
          <option value="">{names.length ? "Open scene…" : "No scenes yet"}</option>
          {names.map((n) => <option key={n}>{n}</option>)}
        </Select>
        <Button size="sm" variant="outline" onClick={create}>New</Button>
        <Button size="sm" disabled={!open} onClick={save}>Save{hist.dirty ? " *" : ""}</Button>
        <Button size="sm" variant="outline" disabled={!open} onClick={() => open && load(open)}>Reload</Button>
        <Button size="sm" variant="outline" disabled={!hist.canUndo} onClick={() => { hist.undo(); setIssues(validateScene(hist.doc)); bump(); }}>Undo</Button>
        <Button size="sm" variant="outline" disabled={!hist.canRedo} onClick={() => { hist.redo(); setIssues(validateScene(hist.doc)); bump(); }}>Redo</Button>
        <span className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{status}</span>
        {open && doc.kind !== "frontend" && (
          <span className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }} data-testid="play-hint">
            Play mode runs "{open}"{hist.dirty ? " with your unsaved edits (the file stays as saved)" : ""}
          </span>
        )}
      </div>
      {issues.length > 0 && (
        <ul className="rounded-md border border-border p-2 text-xs text-red-500" role="alert">
          {issues.map((i, k) => <li key={k}><code>{i.path || "(scene)"}</code>: {i.message}</li>)}
        </ul>
      )}
      {/* EB4: the viewport is the workspace, so it takes the room and the
          rest is a rail either side of it — the tree and what you can drop
          on the left, the selection on the right. */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(190px,1fr)_minmax(420px,4fr)_minmax(240px,1.4fr)] gap-3">
        <div className="grid min-h-0 grid-rows-[minmax(0,3fr)_minmax(0,2fr)] gap-2">
        <section className="m3-scroll min-h-0 overflow-auto" aria-label="Outliner">
          <SectionTitle>Outliner</SectionTitle>
          <div className="mb-2 flex flex-wrap gap-1">
            <Button size="sm" variant="outline" disabled={!open} onClick={() => {
              const id = nextId(doc, "node");
              run("add node", (d) => addNode(d, selected, { id, kind: "group" }));
              select(id);
            }}>Add child</Button>
            <Button size="sm" variant="outline" disabled={sel.ids.length === 0} onClick={deleteSelection}>
              {sel.ids.length > 1 ? `Delete ${sel.ids.length}` : "Delete"}
            </Button>
            <Button size="sm" variant="outline" disabled={!node} onClick={() => node && run("move to root", (d) => moveNode(d, node.id, null))}>To root</Button>
            {/* EB3: arrange it in the viewport, then make it the prefab. */}
            <Button
              size="sm"
              variant="outline"
              disabled={sel.ids.length === 0}
              data-testid="make-prefab"
              onClick={() => {
                setMakeIssues([]);
                setMaking(true);
              }}
            >
              Make prefab
            </Button>
          </div>
          {rows(doc.nodes).map(({ node: n, depth }) => (
            <div
              key={n.id}
              role="treeitem"
              aria-selected={sel.ids.includes(n.id)}
              tabIndex={0}
              onClick={(e) => clickNode(n.id, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey }, "outliner")}
              onKeyDown={(e) => e.key === "Enter" && clickNode(n.id, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey }, "outliner")}
              onContextMenu={(e) => {
                e.preventDefault();
                select(n.id);
                setCtx({ id: n.id, x: e.clientX, y: e.clientY });
              }}
              className="cursor-pointer rounded px-2 py-1"
              style={{
                paddingLeft: 8 + depth * 14,
                // The primary is the stronger fill: the set is what will
                // move, the primary is what the gizmo is on.
                background: n.id === selected
                  ? "var(--m3-secondary-container)"
                  : sel.ids.includes(n.id)
                    ? "color-mix(in srgb, var(--m3-secondary-container) 55%, transparent)"
                    : undefined,
              }}
            >
              {renaming === n.id ? (
                <input
                  autoFocus
                  className="w-full rounded border px-1 text-sm"
                  defaultValue={n.name || n.id}
                  onBlur={(e) => {
                    // Escape cancels; the blur that follows unmounting must not commit.
                    if (renameCancelled.current) {
                      renameCancelled.current = false;
                      return;
                    }
                    const v = e.target.value.trim();
                    if (v && v !== (n.name || n.id)) run("rename node", (d) => setNodeProp(d, n.id, "name", v));
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    else if (e.key === "Escape") {
                      renameCancelled.current = true;
                      setRenaming(null);
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <span className="flex items-baseline gap-1.5">
                    {/* The name takes the free space first: before EB4 the
                        chips pushed it down to "Aren…" on every row. */}
                    <span className="min-w-0 flex-1 truncate">{n.name || n.id}</span>
                    <span className="shrink-0 text-xs opacity-60">{n.prefab ?? n.kind ?? "group"}</span>
                    {/* EU4: the component chips both mockups put on every
                        outliner row. Same data the ECS entity list has always
                        badged; this tree simply never drew it. */}
                    <OutlinerBadges node={n} />
                  </span>
                </>
              )}
            </div>
          ))}
          {ctx && <span className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null); }} />}
          {ctx && (
            <div
              className="fixed z-50 min-w-40 rounded-lg border py-1 shadow-lg"
              style={{
                left: ctx.x,
                top: ctx.y,
                background: "var(--m3-surface)",
                borderColor: "var(--m3-outline-variant)",
              }}
              role="menu"
              onMouseLeave={() => setCtx(null)}
            >
              {[
                { label: "Rename", run: () => { setRenaming(ctx.id); setCtx(null); } },
                { label: "Duplicate", run: () => { setCtx(null); duplicateNode(ctx.id); } },
                { label: "Delete", run: () => { setCtx(null); deleteNode(ctx.id); } },
              ].map((item) => (
                <button
                  key={item.label}
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--m3-secondary-container)]"
                  onClick={item.run}
                  role="menuitem"
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
          {open && doc.nodes.length === 0 && <p className="text-xs opacity-70">Empty scene. Add a node.</p>}
        </section>
        <ScenePalette
          enabled={Boolean(open)}
          onPlace={(prefab, position) => {
            const placed = placePrefab(hist.doc, prefab, position);
            run(`place ${prefab}`, () => placed.doc);
            select(placed.id, "viewport");
          }}
        />
        </div>
        <section className="min-h-0" aria-label="Viewport">
          <SceneViewport
            doc={doc}
            selection={sel}
            onSelect={(id, mods) => clickNode(id, mods, "viewport")}
            onTransform={(id, t) => {
              // EB2: the gizmo drags the primary; everything else selected
              // moves by the same amount, in the same undo step.
              const before = findNode(hist.doc, id)?.transform?.position ?? [0, 0, 0];
              const delta = positionDelta([...before] as [number, number, number], [...t.position] as [number, number, number]);
              const others = sel.ids.filter((x) => x !== id);
              if (others.length === 0 || !isMove(delta)) {
                run("transform", (d) => keepLiveTransform(d, id, t));
                return;
              }
              const positions: Record<string, [number, number, number]> = {};
              for (const other of others) {
                const n = findNode(hist.doc, other);
                if (n) positions[other] = [...(n.transform?.position ?? [0, 0, 0])] as [number, number, number];
              }
              const moved = offsetPositions(positions, delta);
              run(`move ${sel.ids.length} nodes`, (d) => {
                const withPrimary = keepLiveTransform(d, id, t);
                return Object.keys(moved).reduce((acc, other) => setTransform(acc, other, { position: moved[other] }), withPrimary);
              });
            }}
            onPlace={(prefab, position) => {
              const placed = placePrefab(hist.doc, prefab, position);
              run(`place ${prefab}`, () => placed.doc);
              select(placed.id, "viewport");
            }}
            onDelete={() => deleteSelection()}
          />
        </section>
        <section className="m3-scroll min-h-0 overflow-auto" aria-label="Details">
          <SectionTitle>Details</SectionTitle>
          {sel.ids.length > 1 && (
            <p className="mb-1 text-xs" style={{ color: "var(--m3-on-surface-variant)" }} data-testid="selection-count">
              {selectionLabel(sel)}
            </p>
          )}
          <AlignBar count={sel.ids.length} onAlign={alignSelection} onDistribute={distributeSelection} />
          {!node ? (
            open ? (
              <div className="flex flex-col gap-2">
                <Label>Scene kind</Label>
                <Select size="md" value={doc.kind} onChange={(e) => run("scene kind", (d) => ({ ...d, kind: e.target.value as SceneKind }))}>
                  {SCENE_KINDS.map((k) => <option key={k}>{k}</option>)}
                </Select>
                <Button size="sm" variant="outline" onClick={() => {
                  const id = nextId(doc, "node");
                  run("add node", (d) => addNode(d, null, { id, kind: "group" }));
                  select(id);
                }}>Add root node</Button>
              </div>
            ) : <p className="text-xs opacity-70">Open or create a scene.</p>
          ) : (
            <div className="flex flex-col gap-2">
              <Label>Id</Label>
              <Input className="h-9" value={node.id} readOnly />
              <Label>Name</Label>
              <Input className="h-9" value={node.name ?? ""} onChange={(e) => run("rename", (d) => setNodeProp(d, node.id, "name", e.target.value))} />
              <Label>Kind</Label>
              <Select size="md" value={node.kind ?? "group"} onChange={(e) => run("kind", (d) => setNodeProp(d, node.id, "kind", e.target.value))}>
                {NODE_KINDS.map((k) => <option key={k}>{k}</option>)}
              </Select>
              <Label>Prefab</Label>
              <Input className="h-9" value={node.prefab ?? ""} placeholder="e.g. camps/goblin" onChange={(e) => run("prefab", (d) => setNodeProp(d, node.id, "prefab", e.target.value))} />
              {/* EB3: what this node takes from its prefab, and what it says
                  differently. The components below are the overrides. */}
              {node.prefab && (
                <PrefabInstanceCard
                  node={node}
                  prefab={prefabOf(prefabTable, node.prefab)}
                  onRevert={(component, field) => run("revert override", (d) => clearOverride(d, node.id, component, field))}
                />
              )}
              {(["position", "rotation", "scale"] as const).map((key) => (
                <div key={key}>
                  <Label>{key}</Label>
                  <div className="grid grid-cols-3 gap-1">
                    {[0, 1, 2].map((i) => (
                      <Input key={i} type="number" className="h-9" aria-label={`${key} ${"xyz"[i]}`}
                        value={String((node.transform?.[key] ?? (key === "scale" ? [1, 1, 1] : [0, 0, 0]))[i])}
                        onChange={(e) => Number.isFinite(Number(e.target.value)) && setVec(key, i, Number(e.target.value))} />
                    ))}
                  </div>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                disabled={!live}
                title="Copy the live entity selected in play mode into this node (undoable)"
                onClick={() => live && run("keep live transform", (d) => keepLiveTransform(d, node.id, live.t))}
              >
                {live ? `Keep ${live.label} here` : "Keep (select a live entity in play mode)"}
              </Button>
              <SectionTitle>Components</SectionTitle>
              {Object.entries(node.components ?? {}).map(([cn, props]) => (
                <div key={cn} className="rounded-md border border-border p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <strong>{COMPONENTS[cn]?.label ?? cn}</strong>
                    <Button size="sm" variant="outline" onClick={() => run("remove component", (d) => removeComponent(d, node.id, cn))}>Remove</Button>
                  </div>
                  {Object.entries(COMPONENTS[cn]?.fields ?? {}).map(([fn, spec]) => (
                    <div key={fn} className="mb-1">
                      <Label>{fn}</Label>
                      <FieldInput spec={spec} value={props[fn]} onChange={(v) => run("edit component", (d) => setComponentField(d, node.id, cn, fn, v))} />
                    </div>
                  ))}
                </div>
              ))}
              <Select size="md" value="" aria-label="Add component" onChange={(e) => e.target.value && run("add component", (d) => addComponent(d, node.id, e.target.value))}>
                <option value="">Add component…</option>
                {Object.keys(COMPONENTS).filter((c) => !node.components?.[c]).map((c) => <option key={c} value={c}>{COMPONENTS[c].label}</option>)}
              </Select>
            </div>
          )}
        </section>
      </div>
      <MakePrefabDialog
        open={making}
        doc={doc}
        ids={sel.ids}
        existing={prefabNames(prefabTable)}
        busy={makeBusy}
        issues={makeIssues}
        onCancel={() => setMaking(false)}
        onMake={(name) => void makePrefab(name)}
      />
    </div>
  );
}
