/**
 * What a Play setup does once the owned server is up (EA14): which client
 * runs in the viewport, which open in the player's client window (with
 * their seeded accounts), and where the avatar starts. Pure; the panel
 * (play-mode.tsx) carries it out.
 */
import type { FlowDoc } from "@mmo-engine/scene";
import { playFromUrl } from "../flow-client.js";
import type { PlayStartOptions } from "../play-mode.js";
import { CAMERA, botsCount, clientCount, latencyMs, useEdge, type PlaySetup } from "../play-setups.js";

/** The server-side half of a setup: what the host start route is told. */
export function startOptions(setup: PlaySetup): PlayStartOptions {
  return {
    bots: botsCount(setup),
    clients: clientCount(setup),
    network: useEdge(setup) ? "edge" : "core",
    latencyMs: latencyMs(setup),
    fresh: setup.fresh,
    keep: setup.keep,
  };
}

export interface LaunchPlan {
  /** The flow node the clients start at (the camera start is the world node). */
  node: string;
  /** Index of the account the viewport plays as; null when nobody plays in the viewport. */
  viewportAccount: number | null;
  /** Indices of the accounts that open in the player's client window. */
  windowAccounts: number[];
  /** Move the viewport avatar to the Scenes camera after joining. */
  teleportToCamera: boolean;
}

const isWorldNode = (doc: FlowDoc | null, node: string): boolean => (doc ? doc.nodes[node]?.scene === "@assigned" : node === "world");

export function planLaunch(setup: PlaySetup, doc: FlowDoc | null): LaunchPlan {
  const n = clientCount(setup);
  const node = setup.from === CAMERA ? (doc ? (Object.keys(doc.nodes).find((k) => isWorldNode(doc, k)) ?? "world") : "world") : setup.from;
  const all = Array.from({ length: n }, (_, i) => i);
  if (setup.where === "simulate") return { node, viewportAccount: null, windowAccounts: [], teleportToCamera: false };
  // The viewport shows the world, so only a world start can play in it; any other node needs the client.
  if (setup.where === "viewport" && isWorldNode(doc, node)) {
    return { node, viewportAccount: 0, windowAccounts: all.slice(1), teleportToCamera: setup.from === CAMERA };
  }
  return { node, viewportAccount: null, windowAccounts: all, teleportToCamera: false };
}

/** The address of the player's client for one account, starting at the plan's node. */
export function clientWindowUrl(
  doc: FlowDoc,
  node: string,
  clientBase: string,
  server: { url: string; user: string; pass: string },
): { url: string } | { error: string } {
  return playFromUrl(doc, node, { client: clientBase, server });
}
