/**
 * Browser-safe flow adapter for the editor UI (roadmap EA8): plain HTTP to
 * `/api/editor/flow` (flow-host.ts) plus the Play-from URL builder. A
 * refused save throws FlowSaveError with every problem by path.
 */
import { IssuesError, invalidMessage, requestJson } from "./api.js";
import { flowEventsTo, type FlowDoc, type SceneIssue } from "@mmo-engine/scene";

export class FlowSaveError extends IssuesError<SceneIssue> {
  constructor(issues: SceneIssue[]) {
    super(issues, invalidMessage("flow", issues.length));
  }
}

const refused = (issues: SceneIssue[]): Error => new FlowSaveError(issues);

export interface FlowBundle {
  content: FlowDoc;
  /** Scene names a node may use. */
  scenes: string[];
  /** Event names an edge may fire on. */
  events: string[];
}

export const getFlow = (base = ""): Promise<FlowBundle> => requestJson(`${base}/api/editor/flow`, { fail: "flow read failed", refused });

/** Validate on the host and write only when valid; throws FlowSaveError otherwise. */
export const saveFlow = (content: FlowDoc, base = ""): Promise<void> =>
  requestJson(`${base}/api/editor/flow`, { method: "PUT", body: { content }, fail: "flow save failed", refused });

export interface PlayOptions {
  /** The client dev server, e.g. http://localhost:5173. */
  client: string;
  /** A running game server and its dev account; needed to skip past login. */
  server?: { url: string; user: string; pass: string };
}

/**
 * Where "Play from <node>" opens. The login node is the plain client.
 * Character creation with no server uses the client's serverless preview;
 * with a server (and for character select and world) the client logs in
 * and the flow takes it to the node (`?start=`, see apps/client App.tsx).
 */
export function playFromUrl(doc: FlowDoc, node: string, opts: PlayOptions): { url: string } | { error: string } {
  const scene = doc.nodes[node]?.scene;
  if (scene === undefined) return { error: `no node "${node}"` };
  if (flowEventsTo(doc, node) === null) return { error: `"${node}" is unreachable from the start node` };
  const base = opts.client.replace(/\/+$/, "");
  if (node === doc.start) return { url: `${base}/` };
  if (!opts.server) {
    if (scene === "character-creation") return { url: `${base}/?preview=character` };
    return { error: `Play from "${node}" needs a running server: enter its URL and a dev account` };
  }
  const q = new URLSearchParams({ start: node, server: opts.server.url, user: opts.server.user, pass: opts.server.pass });
  return { url: `${base}/?${q.toString()}` };
}
