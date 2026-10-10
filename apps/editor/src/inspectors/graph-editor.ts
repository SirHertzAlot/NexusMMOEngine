/**
 * Hierarchical PICG graph editor (ROADMAP E7, PICG slice 4) — the model
 * and view-model, in pure TS (no React, no DOM), like inspectors/ecs.ts.
 *
 * Documents are the library's `.pcg` graphs and `.pcgsubgraph` parts
 * (pcg-host.ts). The editor opens one and walks its hierarchy: a
 * `Subgraph` node enters the embedded definition it instances, a
 * `SubgraphAsset` node opens the linked part (another document), and the
 * breadcrumb climbs back out. Each open document keeps its own edits,
 * undo and redo, and dirty flag, so a tree and the trunk part it links
 * can be changed together and saved together.
 *
 * Edits are commands: move a node, set or delete a node property, set a
 * parameter's default. Saving goes through the host, which validates the
 * way the server cooks (pcg-host.ts validatePcgDocument).
 */

import { verticalCurve } from "../graph-view.js";
import { canonicalGuid, cloneGraph, StructuralNode, type PcgEdge, type PcgNode, type PcgParameter } from "@mmo-engine/picg";

/** A graph level: a document's root, or an embedded subgraph definition. */
interface Level {
  nodes: PcgNode[];
  edges: PcgEdge[];
  parameters?: PcgParameter[];
}

/** An editable document (a `.pcg` or a `.pcgsubgraph`): plain JSON. */
export interface GraphDocument extends Level {
  version: string;
  name?: string;
  description?: string;
  subgraphs?: Array<Level & { id: string; name?: string }>;
  inputs?: Array<{ id: string; name?: string; pinType?: string }>;
  outputs?: Array<{ id: string; name?: string; pinType?: string }>;
  [key: string]: unknown;
}

/** Where the editor is: a document, and the embedded definitions entered inside it. */
export interface Crumb {
  file: string;
  /** Embedded definition ids, outermost first (empty: the document's root). */
  defs: string[];
  /** The node entered from the level above (its title in the breadcrumb). */
  via?: string;
}

export type GraphCommand =
  | { kind: "move"; node: string; x: number; y: number }
  | { kind: "setData"; node: string; key: string; value: unknown }
  | { kind: "deleteData"; node: string; key: string }
  | { kind: "setParameterDefault"; parameter: string; value: unknown };

export interface NodeView {
  id: string;
  type: string;
  title: string;
  x: number;
  y: number;
  /** Input and output pins, from the node's edges and its subgraph interface. */
  inputs: string[];
  outputs: string[];
  /** Double-click opens it: an embedded definition or a linked part. */
  enter: { kind: "definition"; id: string } | { kind: "asset"; file: string } | { kind: "missing"; guid: string } | null;
  structural: boolean;
}

export interface EdgeView {
  id: string;
  source: string;
  sourcePin: string;
  target: string;
  targetPin: string;
}

export interface PropertyView {
  key: string;
  value: unknown;
  /** How the panel edits it. */
  editor: "number" | "boolean" | "text" | "json";
}

export interface ParameterView {
  id: string;
  name: string;
  type: string;
  value: unknown;
  editor: "number" | "boolean" | "text" | "json";
  target: string;
  range?: [number, number];
}

export interface GraphViewModel {
  crumbs: Array<{ label: string; depth: number }>;
  file: string;
  kind: "graph" | "subgraph";
  title: string;
  nodes: NodeView[];
  edges: EdgeView[];
  selected: { node: NodeView; properties: PropertyView[] } | null;
  /** The document's parameters (shown at its root only). */
  parameters: ParameterView[];
  dirty: boolean;
  /** Files with unsaved edits. */
  dirtyFiles: string[];
  canUndo: boolean;
  canRedo: boolean;
}

/** A subgraph part's GUID → its file, from the library's document list. */
export type PartFiles = ReadonlyMap<string, string>;

interface OpenDocument {
  file: string;
  kind: "graph" | "subgraph";
  saved: string;
  doc: GraphDocument;
  undo: GraphDocument[];
  redo: GraphDocument[];
}

const UNDO_LIMIT = 200;

function editorFor(value: unknown): PropertyView["editor"] {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "text";
  return "json";
}

/** A node's display title: PICG's `__nodeTitle`, else its type. */
export function nodeTitle(node: PcgNode): string {
  const t = node.data?.__nodeTitle;
  return typeof t === "string" && t ? t : node.type;
}

export class GraphEditor {
  private readonly docs = new Map<string, OpenDocument>();
  private path: Crumb[] = [];
  private selectedNode: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly parts: PartFiles) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** Open a document as the root of the breadcrumb (keeps other open documents' edits). */
  open(file: string, kind: "graph" | "subgraph", doc: GraphDocument): void {
    this.load(file, kind, doc);
    this.path = [{ file, defs: [] }];
    this.selectedNode = null;
    this.changed();
  }

  /** Make a document known (a linked part fetched for entering) without moving. */
  load(file: string, kind: "graph" | "subgraph", doc: GraphDocument): void {
    if (this.docs.has(file)) return;
    const text = JSON.stringify(doc);
    this.docs.set(file, { file, kind, saved: text, doc: JSON.parse(text) as GraphDocument, undo: [], redo: [] });
  }

  isLoaded(file: string): boolean {
    return this.docs.has(file);
  }

  get current(): Crumb | null {
    return this.path[this.path.length - 1] ?? null;
  }

  private open_(): OpenDocument {
    const c = this.current;
    const d = c ? this.docs.get(c.file) : undefined;
    if (!c || !d) throw new Error("graph-editor: no document open");
    return d;
  }

  /** The level the breadcrumb points at, in `doc` (embedded definitions sit flat at its top level, as PICG keeps them). */
  private level(doc: GraphDocument, defs: string[]): Level {
    if (defs.length === 0) return doc;
    const id = defs[defs.length - 1];
    const def = (doc.subgraphs ?? []).find((s) => s.id === id);
    if (!def) throw new Error(`graph-editor: no embedded definition '${id}'`);
    return def;
  }

  /**
   * Enter a node: an embedded definition (same document) or a linked part
   * (its document must be loaded first; returns its file so the caller can
   * fetch it, or null when entered).
   */
  enter(nodeId: string): { needs: string } | null {
    const view = this.viewModel().nodes.find((n) => n.id === nodeId);
    const c = this.current;
    if (!view?.enter || !c) return null;
    if (view.enter.kind === "definition") {
      this.path.push({ file: c.file, defs: [...c.defs, view.enter.id], via: view.title });
    } else if (view.enter.kind === "asset") {
      if (!this.docs.has(view.enter.file)) return { needs: view.enter.file };
      this.path.push({ file: view.enter.file, defs: [], via: view.title });
    } else {
      return null;
    }
    this.selectedNode = null;
    this.changed();
    return null;
  }

  /** Climb the breadcrumb to `depth` (0: the opened document's root). */
  up(depth: number): void {
    if (depth < 0 || depth >= this.path.length - 1) return;
    this.path = this.path.slice(0, depth + 1);
    this.selectedNode = null;
    this.changed();
  }

  select(nodeId: string | null): void {
    this.selectedNode = nodeId;
    this.changed();
  }

  /** Apply an edit to the current level's document (undoable). */
  apply(cmd: GraphCommand): void {
    const d = this.open_();
    const c = this.current!;
    const next = cloneGraph(d.doc);
    const level = this.level(next, c.defs);
    if (cmd.kind === "setParameterDefault") {
      const p = (next.parameters ?? []).find((x) => x.id === cmd.parameter);
      if (!p) throw new Error(`graph-editor: no parameter '${cmd.parameter}'`);
      p.default = cmd.value;
    } else {
      const node = level.nodes.find((n) => n.id === cmd.node);
      if (!node) throw new Error(`graph-editor: no node '${cmd.node}'`);
      if (cmd.kind === "move") node.position = { x: Math.round(cmd.x), y: Math.round(cmd.y) };
      else if (cmd.kind === "setData") node.data = { ...(node.data ?? {}), [cmd.key]: cmd.value };
      else {
        const data = { ...(node.data ?? {}) };
        delete data[cmd.key];
        node.data = data;
      }
    }
    // A drag sends many moves: they merge into one undo step per node.
    const last = d.undo[d.undo.length - 1];
    const merge = cmd.kind === "move" && last !== undefined && this.lastMove === `${d.file}:${c.defs.join("/")}:${cmd.node}`;
    if (!merge) {
      d.undo.push(d.doc);
      if (d.undo.length > UNDO_LIMIT) d.undo.shift();
    }
    this.lastMove = cmd.kind === "move" ? `${d.file}:${c.defs.join("/")}:${cmd.node}` : null;
    d.redo = [];
    d.doc = next;
    this.changed();
  }

  private lastMove: string | null = null;

  /** End a drag: the next move starts a new undo step. */
  endMove(): void {
    this.lastMove = null;
  }

  undo(): void {
    const d = this.open_();
    const prev = d.undo.pop();
    if (!prev) return;
    d.redo.push(d.doc);
    d.doc = prev;
    this.lastMove = null;
    this.changed();
  }

  redo(): void {
    const d = this.open_();
    const next = d.redo.pop();
    if (!next) return;
    d.undo.push(d.doc);
    d.doc = next;
    this.lastMove = null;
    this.changed();
  }

  /** Every document with unsaved edits, with its JSON to save. */
  pendingSaves(): Array<{ file: string; doc: GraphDocument }> {
    return [...this.docs.values()].filter((d) => JSON.stringify(d.doc) !== d.saved).map((d) => ({ file: d.file, doc: d.doc }));
  }

  /** The host accepted a save: this is the document's saved state now. */
  markSaved(file: string): void {
    const d = this.docs.get(file);
    if (!d) return;
    d.saved = JSON.stringify(d.doc);
    this.changed();
  }

  /** Throw away a document's edits. */
  revert(file: string): void {
    const d = this.docs.get(file);
    if (!d) return;
    d.doc = JSON.parse(d.saved) as GraphDocument;
    d.undo = [];
    d.redo = [];
    this.changed();
  }

  viewModel(): GraphViewModel {
    const c = this.current;
    const d = c ? this.docs.get(c.file) : undefined;
    const dirtyFiles = this.pendingSaves().map((p) => p.file);
    if (!c || !d) {
      return { crumbs: [], file: "", kind: "graph", title: "", nodes: [], edges: [], selected: null, parameters: [], dirty: false, dirtyFiles, canUndo: false, canRedo: false };
    }
    const level = this.level(d.doc, c.defs);
    const pins = new Map<string, { inputs: Set<string>; outputs: Set<string> }>();
    const pinsOf = (id: string) => {
      let p = pins.get(id);
      if (!p) pins.set(id, (p = { inputs: new Set(), outputs: new Set() }));
      return p;
    };
    for (const e of level.edges) {
      pinsOf(e.source).outputs.add(e.sourceHandle ?? "out");
      pinsOf(e.target).inputs.add(e.targetHandle ?? "in");
    }
    const nodes = level.nodes.map((n): NodeView => {
      const p = pinsOf(n.id);
      for (const port of n.subgraphInterface?.inputs ?? []) p.inputs.add(port.id);
      for (const port of n.subgraphInterface?.outputs ?? []) p.outputs.add(port.id);
      let enter: NodeView["enter"] = null;
      if (n.type === StructuralNode.Subgraph && typeof n.data?.subgraphId === "string") {
        enter = { kind: "definition", id: n.data.subgraphId };
      } else if (n.type === StructuralNode.SubgraphAsset && typeof n.data?.assetGuid === "string") {
        const guid = canonicalGuid(n.data.assetGuid);
        const file = this.parts.get(guid);
        enter = file ? { kind: "asset", file } : { kind: "missing", guid };
      }
      return {
        id: n.id,
        type: n.type,
        title: nodeTitle(n),
        x: n.position?.x ?? 0,
        y: n.position?.y ?? 0,
        inputs: [...p.inputs],
        outputs: [...p.outputs],
        enter,
        structural: Object.values(StructuralNode).includes(n.type as never),
      };
    });
    const edges = level.edges.map((e) => ({ id: e.id, source: e.source, sourcePin: e.sourceHandle ?? "out", target: e.target, targetPin: e.targetHandle ?? "in" }));
    const sel = this.selectedNode ? nodes.find((n) => n.id === this.selectedNode) : undefined;
    const selNode = sel ? level.nodes.find((n) => n.id === sel.id) : undefined;
    const properties = selNode
      ? Object.entries(selNode.data ?? {})
          .filter(([k]) => k !== "__nodeTitle")
          .map(([key, value]) => ({ key, value, editor: editorFor(value) }))
      : [];
    const parameters =
      c.defs.length === 0
        ? (d.doc.parameters ?? []).map((p): ParameterView => ({
            id: p.id,
            name: p.name,
            type: p.type,
            value: p.default,
            editor: p.type === "number" || p.type === "integer" ? "number" : p.type === "boolean" ? "boolean" : p.type === "string" || p.type === "color" ? "text" : "json",
            target: `${p.targetNode ?? "?"}.${p.targetProperty ?? "?"}`,
            ...(p.hasRange && typeof p.min === "number" && typeof p.max === "number" ? { range: [p.min, p.max] as [number, number] } : {}),
          }))
        : [];
    const docTitle = d.doc.name ?? c.file;
    const crumbs = this.path.map((p, depth) => ({ label: depth === 0 ? (this.docs.get(p.file)?.doc.name ?? p.file) : (p.via ?? p.defs[p.defs.length - 1] ?? p.file), depth }));
    return {
      crumbs,
      file: c.file,
      kind: d.kind,
      title: c.defs.length ? `${docTitle} › ${c.defs[c.defs.length - 1]}` : docTitle,
      nodes,
      edges,
      selected: sel ? { node: sel, properties } : null,
      parameters,
      dirty: dirtyFiles.includes(c.file),
      dirtyFiles,
      canUndo: d.undo.length > 0,
      canRedo: d.redo.length > 0,
    };
  }
}

/** Parse what a property or parameter field typed: by its editor kind. Throws on bad JSON or numbers. */
export function parseFieldValue(editor: PropertyView["editor"], text: string): unknown {
  switch (editor) {
    case "number": {
      const n = Number(text);
      if (text.trim() === "" || !Number.isFinite(n)) throw new Error(`not a number: ${text}`);
      return n;
    }
    case "boolean":
      return text === "true";
    case "text":
      return text;
    default:
      return JSON.parse(text) as unknown;
  }
}

/** For the canvas: a cubic edge from an output pin (a node's bottom) down to an input pin (a node's top); PICG graphs flow downwards. */
export const edgePath = verticalCurve;
