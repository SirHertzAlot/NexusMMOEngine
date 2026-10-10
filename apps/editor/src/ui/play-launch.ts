/**
 * Starting Play at a flow node other than the world (EA14): the viewport
 * shows only the world, so those starts open the player's client, one window
 * per seeded account, at the chosen node. Pure; the panel carries it out.
 */
import type { FlowDoc } from "@mmo-engine/scene";
import { playFromUrl } from "../flow-client.js";
import { clientCount, type PlaySetup } from "./play-setup.js";

/** The flow's world node (the one that takes the server-assigned scene), "world" without a flow. */
export function worldNodeOf(doc: FlowDoc | null): string {
  return (doc && Object.keys(doc.nodes).find((k) => doc.nodes[k]?.scene === "@assigned")) || "world";
}

/** The nodes the Start node menu offers: the world, the scene camera, then the other flow nodes in document order. */
export function startChoices(doc: FlowDoc | null, fallback: readonly string[]): Array<{ value: string; label: string }> {
  if (!doc) return fallback.map((v) => ({ value: v, label: v }));
  const world = worldNodeOf(doc);
  return [
    { value: "World", label: `World (node ${world})` },
    { value: "Camera position", label: "Camera position" },
    ...Object.keys(doc.nodes)
      .filter((k) => k !== world)
      .map((k) => ({ value: k, label: `${k} (${doc.nodes[k]!.scene})` })),
  ];
}

export interface ClientWindow {
  username: string;
  url: string;
}

/** One player-client address per account of the session, all starting at `node`. */
export function clientWindows(
  setup: PlaySetup,
  doc: FlowDoc,
  node: string,
  clientBase: string,
  server: { url: string; username: string; password: string; loadUsers?: string[] },
): { windows: ClientWindow[] } | { error: string } {
  const users = [server.username, ...(server.loadUsers ?? [])].slice(0, clientCount(setup));
  const windows: ClientWindow[] = [];
  for (const username of users) {
    const r = playFromUrl(doc, node, { client: clientBase, server: { url: server.url, user: username, pass: server.password } });
    if ("error" in r) return { error: r.error };
    windows.push({ username, url: r.url });
  }
  return { windows };
}
