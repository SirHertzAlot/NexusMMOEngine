/**
 * In-memory editor clipboard for document nodes (scene nodes, flow nodes…).
 *
 * A single slot holding a JSON-serializable value plus the kind that wrote
 * it ("scene-node", …). Panels copy to it and paste from it; pasting into
 * a different kind is refused. In-memory (not the OS clipboard): no
 * permissions prompts, and node structures survive intact.
 */

import { createStore } from "../store.js";

export interface ClipboardValue {
  kind: string;
  data: unknown;
}

// A write always changes the clipboard, even to equal data: the version tells menus to refresh.
const store = createStore<{ slot: ClipboardValue | null; version: number }>({ slot: null, version: 0 }, () => false);

export function writeClipboard(kind: string, data: unknown): void {
  // Structured clone so later edits to the document do not mutate the copy.
  store.set((c) => ({ slot: { kind, data: structuredClone(data) }, version: c.version + 1 }));
}

export function readClipboard(kind: string): unknown | null {
  const { slot } = store.get();
  if (!slot || slot.kind !== kind) return null;
  return structuredClone(slot.data);
}

export function clearClipboard(): void {
  store.set((c) => ({ slot: null, version: c.version + 1 }));
}

export const subscribeClipboard = store.subscribe;
export const clipboardVersion = (): number => store.get().version;
export const peekClipboard = (): ClipboardValue | null => store.get().slot;
