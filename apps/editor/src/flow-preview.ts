/**
 * Seeing the screen a flow node leads to, without leaving the flow (EB6).
 *
 * "Play from" opened the client in another tab, so the graph you are
 * editing and the screen it describes were never on the screen together —
 * the one thing a flow editor is for. The URL is already worked out
 * (`playFromUrl`); this adds where it is shown and at what size, and the
 * masking, which matters: that URL carries the dev account's password in
 * its query string, so nothing may print it as it is.
 */

import type { FlowDoc } from "@mmo-engine/scene";
import { playFromUrl, type PlayOptions } from "./flow-client.js";

export interface PreviewSize {
  id: string;
  label: string;
  width: number;
  height: number;
}

/** The frames the preview offers. "Fit" fills the pane, which is the default. */
export const PREVIEW_SIZES: readonly PreviewSize[] = [
  { id: "fit", label: "Fit", width: 0, height: 0 },
  { id: "desktop", label: "1280 × 720", width: 1280, height: 720 },
  { id: "laptop", label: "1024 × 640", width: 1024, height: 640 },
  { id: "phone", label: "390 × 844", width: 390, height: 844 },
];

export function previewSize(id: string): PreviewSize {
  return PREVIEW_SIZES.find((s) => s.id === id) ?? PREVIEW_SIZES[0];
}

/** A frame's CSS size: "fit" fills its pane, the rest are fixed and centred. */
export function frameStyle(size: PreviewSize): { width: string; height: string } {
  return size.width === 0
    ? { width: "100%", height: "100%" }
    : { width: `${size.width}px`, height: `${size.height}px` };
}

/**
 * The URL with every secret taken out of it, for showing on screen or
 * writing to the console. The dev account's password rides in the query
 * (`pass=`), and the user name is the account's too, so both go.
 */
export function maskUrl(url: string): string {
  return url.replace(/([?&](?:pass|password|user|token)=)[^&#]*/gi, "$1…");
}

export interface PreviewTarget {
  node: string;
  url: string;
  /** The same URL with the account details masked: this is the one to show. */
  shown: string;
}

/** Where the preview should point for `node`, or why it cannot. */
export function previewTarget(doc: FlowDoc, node: string, opts: PlayOptions): PreviewTarget | { error: string } {
  const r = playFromUrl(doc, node, opts);
  if ("error" in r) return r;
  return { node, url: r.url, shown: maskUrl(r.url) };
}

/**
 * What the pane says when it has nothing to show. Separate from the
 * component so the wording is testable, and because "no client running" and
 * "pick a node" are different problems.
 */
export function emptyPreviewNote(client: string, picked: string | null): string {
  if (client.trim().length === 0) return "Enter the client's dev server URL above to preview a screen here.";
  if (picked === null) return "Pick a node to see the screen it leads to.";
  return "";
}
